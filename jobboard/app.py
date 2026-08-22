import os
import time
import requests
from flask import Flask, render_template, jsonify

FEED_URL = os.environ.get(
    "JOBS_FEED_URL",
    "https://raw.githubusercontent.com/sudheer-050/HAI-messenger/master/jobs/feed.json",
)
CACHE_TTL = int(os.environ.get("FEED_CACHE_TTL", "300"))

app = Flask(__name__)

_cache: dict = {"data": None, "fetched_at": 0.0}


def _fetch_feed() -> dict:
    now = time.monotonic()
    if _cache["data"] is not None and (now - _cache["fetched_at"]) < CACHE_TTL:
        return _cache["data"]

    try:
        resp = requests.get(FEED_URL, timeout=10)
        resp.raise_for_status()
        raw = resp.json()
    except Exception as exc:
        if _cache["data"] is not None:
            return _cache["data"]
        raise RuntimeError(f"Failed to fetch job feed: {exc}") from exc

    validated = _validate(raw)
    _cache["data"] = validated
    _cache["fetched_at"] = now
    return validated


def _validate(raw: dict) -> dict:
    """Return a sanitised feed keeping only valid, qualified records."""
    if not isinstance(raw, dict):
        raise ValueError("Feed root must be a JSON object")
    jobs_raw = raw.get("jobs", [])
    if not isinstance(jobs_raw, list):
        raise ValueError("Feed 'jobs' must be an array")

    required = {
        "source_issue_id", "source_issue_key", "source_status",
        "title", "company", "salary", "location", "work_arrangement",
        "employment_type", "description", "apply_url", "tailored_resume",
        "ats_score", "ats_breakdown", "created_at", "updated_at",
    }
    ats_required = {
        "skills_match", "experience_match", "education_match",
        "keywords_found", "keywords_missing",
    }

    kept = []
    for job in jobs_raw:
        if not isinstance(job, dict):
            continue
        if job.get("source_status") != "in_review":
            continue
        score = job.get("ats_score")
        if not isinstance(score, (int, float)) or score < 80:
            continue
        url = job.get("apply_url", "")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            continue
        if not required.issubset(job.keys()):
            continue
        breakdown = job.get("ats_breakdown", {})
        if not isinstance(breakdown, dict) or not ats_required.issubset(breakdown.keys()):
            continue
        kept.append(job)

    return {
        "schema_version": raw.get("schema_version", "1.0"),
        "generated_at": raw.get("generated_at", ""),
        "jobs": kept,
    }


@app.route("/")
def index():
    error = None
    feed = {"jobs": [], "generated_at": "", "schema_version": "1.0"}
    try:
        feed = _fetch_feed()
    except Exception as exc:
        error = str(exc)
    return render_template("index.html", feed=feed, error=error)


@app.route("/feed.json")
def feed_json():
    try:
        data = _fetch_feed()
        return jsonify(data)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route("/healthz")
def health():
    return "ok", 200
