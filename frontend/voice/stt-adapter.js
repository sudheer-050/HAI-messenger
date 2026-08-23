// STT adapter for HAI Messenger voice control — wraps vosk-browser v0.0.8 (Apache-2.0).
//
// Delivers fully local, offline-capable speech-to-text using Vosk-WASM.
// No audio or transcript ever leaves the device; mic is released on stop().
//
// ## Lifecycle
//   const stt = new STTAdapter();
//   await stt.init(onProgress);   // one-time: loads library + downloads/caches model
//   await stt.start();            // requests mic, begins streaming recognition
//   stt.stop();                   // releases mic and AudioContext
//   stt.destroy();                // terminates vosk worker; call when permanently disabled
//
// ## Events (via EventTarget)
//   'transcript'  — final recognition result      { detail: { text: string } }
//   'partial'     — interim (in-flight) result    { detail: { text: string } }
//   'error'       — mic or library failure        { detail: { message: string, cause?: Error } }
//
// ## onProgress callback
//   { phase: 'download', ratio: 0..1 }  — first-run 40 MB model download
//   { phase: 'extract',  ratio: 0 }     — WASM extraction / model init (~3–6 s)
//   { phase: 'ready',    ratio: 1 }     — model loaded, ready to call start()
//
// ## CSP note
//   vosk-browser bundles the WASM binary inside vosk.js and compiles it at runtime.
//   If a Content-Security-Policy header is ever added to this app, the script-src
//   directive must include 'wasm-unsafe-eval' (Chrome 95+, Firefox, Safari 16.4+)
//   to allow WebAssembly JIT compilation. Without CSP the browser permits it by
//   default, so no header change is needed today.
//
// ## Browser support
//   Chrome 66+, Firefox 52+, Edge 79+: full support.
//   Safari 15.2+: WASM works; AudioContext.createScriptProcessor is deprecated
//     but still present; replace with AudioWorklet in a future pass.
//   iOS Safari: functional but higher memory pressure; test on ≤3 GB RAM devices.
//   ScriptProcessor (used here) is deprecated. It remains the widest-compat
//   approach for v1 since AudioWorklet WASM+mic pipeline has Safari quirks.

import { getCachedModel, setCachedModel } from './voice-model-cache.js';

const VOSK_LIB_URL = '/voice/lib/vosk.js';
const MODEL_URL = '/voice-model/vosk-model-small-en-us-0.15.tar.gz';
const SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER = 4096;

class STTAdapter extends EventTarget {
    constructor() {
        super();
        this._model = null;
        this._recognizer = null;
        this._audioContext = null;
        this._mediaStream = null;
        this._processor = null;
        this._initialized = false;
    }

    // init() resolves when the model is loaded and the adapter is ready for start().
    // Safe to call multiple times; subsequent calls return immediately.
    async init(onProgress) {
        if (this._initialized) return;

        await _loadScript(VOSK_LIB_URL);

        // Resolve model blob: IDB cache first, then network with progress reporting.
        let modelBlob = await getCachedModel();
        if (!modelBlob) {
            onProgress?.({ phase: 'download', ratio: 0 });
            modelBlob = await _fetchWithProgress(MODEL_URL, ratio => {
                onProgress?.({ phase: 'download', ratio });
            });
            // Store for future sessions; non-fatal if IDB is unavailable.
            setCachedModel(modelBlob).catch(() => {});
        }

        onProgress?.({ phase: 'extract', ratio: 0 });

        // createModel returns a Promise that resolves once the vosk worker has
        // downloaded (or replayed from WASM IDBFS) and extracted the model.
        // Passing logLevel -2 suppresses all non-error vosk console output.
        const blobUrl = URL.createObjectURL(modelBlob);
        try {
            this._model = await Vosk.createModel(blobUrl, -2);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }

        this._initialized = true;
        onProgress?.({ phase: 'ready', ratio: 1 });
    }

    // start() opens the microphone and begins streaming recognition.
    // Emits 'transcript' (final) and 'partial' (interim) events while listening.
    // Resolves once mic is acquired; rejects / emits 'error' on permission denial.
    async start() {
        if (!this._initialized) throw new Error('STTAdapter: call init() before start()');
        if (this._recognizer) return; // already listening

        const recognizer = new this._model.KaldiRecognizer(SAMPLE_RATE);
        recognizer.setWords(false);
        recognizer.on('result', msg => {
            const text = (msg.result?.text ?? '').trim();
            if (text) this.dispatchEvent(new CustomEvent('transcript', { detail: { text } }));
        });
        recognizer.on('partialresult', msg => {
            const text = (msg.result?.partial ?? '').trim();
            if (text) this.dispatchEvent(new CustomEvent('partial', { detail: { text } }));
        });

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    channelCount: 1,
                    sampleRate: SAMPLE_RATE,
                },
                video: false,
            });
        } catch (err) {
            recognizer.remove();
            const message = err.name === 'NotAllowedError'
                ? 'Microphone access denied.'
                : `Microphone unavailable: ${err.message}`;
            this.dispatchEvent(new CustomEvent('error', { detail: { message, cause: err } }));
            return;
        }

        this._recognizer = recognizer;
        this._mediaStream = stream;
        this._audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        const source = this._audioContext.createMediaStreamSource(stream);
        this._processor = this._audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
        this._processor.onaudioprocess = event => {
            try { this._recognizer?.acceptWaveform(event.inputBuffer); } catch {}
        };
        source.connect(this._processor);
        // Connect to destination to keep the AudioContext graph active (required by
        // some browsers even when the output is silent / unused).
        this._processor.connect(this._audioContext.destination);
    }

    // stop() releases the microphone and tears down the AudioContext.
    // Safe to call multiple times or before start().
    stop() {
        if (this._processor) {
            this._processor.onaudioprocess = null;
            this._processor.disconnect();
            this._processor = null;
        }
        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(t => t.stop());
            this._mediaStream = null;
        }
        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
        }
        if (this._recognizer) {
            this._recognizer.remove();
            this._recognizer = null;
        }
    }

    // destroy() terminates the vosk Web Worker and frees all WASM memory.
    // Call once when voice control is permanently disabled (e.g. user opts out).
    destroy() {
        this.stop();
        if (this._model) {
            this._model.terminate();
            this._model = null;
        }
        this._initialized = false;
    }

    get ready()     { return this._initialized; }
    get listening() { return !!this._recognizer; }
}

function _loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) return resolve();
        const s = Object.assign(document.createElement('script'), { src });
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
}

async function _fetchWithProgress(url, onRatio) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Model download failed: ${resp.status} ${resp.statusText}`);
    const total = parseInt(resp.headers.get('content-length') ?? '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total > 0) onRatio(received / total);
    }
    return new Blob(chunks, { type: 'application/octet-stream' });
}

export { STTAdapter };
