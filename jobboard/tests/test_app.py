import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import app as app_module
from wsgi import application as wsgi_application

FEED = {
    "schema_version": "1.0",
    "generated_at": "2026-08-22T00:00:00Z",
    "jobs": [
        {
            "source_issue_id": "00000000-0000-0000-0000-000000000001",
            "source_issue_key": "MYAG-105",
            "source_status": "in_review",
            "title": "<script>alert(1)</script>ML Engineer",
            "company": "Acme & Sons",
            "salary": "Not disclosed",
            "location": "Remote",
            "work_arrangement": "Remote",
            "employment_type": "Full-time",
            "description": "Build <b>ML</b> models.",
            "apply_url": "https://acme.com/jobs/1?ref=<script>",
            "tailored_resume": "Sudheer is great at ML.",
            "ats_score": 85,
            "ats_breakdown": {
                "skills_match": 90,
                "experience_match": 80,
                "education_match": 85,
                "keywords_found": ["Python"],
                "keywords_missing": ["Scala"],
            },
            "created_at": "2026-08-22T00:00:00Z",
            "updated_at": "2026-08-22T00:00:00Z",
        }
    ],
}


@pytest.fixture
def client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def _mock_feed(monkeypatch, feed=None, error=None):
    def fake_fetch():
        if error is not None:
            raise error
        return feed if feed is not None else FEED
    monkeypatch.setattr(app_module, "_fetch_feed", fake_fetch)


def test_empty_state_rendered(client, monkeypatch):
    _mock_feed(monkeypatch, feed={"schema_version": "1.0", "generated_at": "", "jobs": []})
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"No qualified jobs yet" in resp.data


def test_fetch_error_state_rendered(client, monkeypatch):
    _mock_feed(monkeypatch, error=RuntimeError("Failed to fetch job feed: boom"))
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Could not load job feed" in resp.data
    assert b"boom" in resp.data


def test_job_card_renders_required_fields(client, monkeypatch):
    _mock_feed(monkeypatch)
    resp = client.get("/")
    body = resp.data.decode()
    assert "Acme &amp; Sons" in body
    assert "Not disclosed" in body
    assert "Remote" in body
    assert "85%" in body


def test_feed_content_is_escaped_not_rendered_as_html(client, monkeypatch):
    _mock_feed(monkeypatch)
    resp = client.get("/")
    body = resp.data.decode()
    assert "<script>alert(1)</script>" not in body
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in body
    assert "<b>ML</b>" not in body
    assert "&lt;b&gt;ML&lt;/b&gt;" in body


def test_apply_url_is_escaped_and_outbound_safe(client, monkeypatch):
    _mock_feed(monkeypatch)
    resp = client.get("/")
    body = resp.data.decode()
    assert 'href="https://acme.com/jobs/1?ref=&lt;script&gt;"' in body
    assert 'target="_blank"' in body
    assert 'rel="noopener noreferrer"' in body
    assert "Apply on Acme &amp; Sons&#39;s site" in body or "Apply on Acme &amp; Sons's site" in body


def test_feed_json_endpoint(client, monkeypatch):
    _mock_feed(monkeypatch)
    resp = client.get("/feed.json")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["jobs"][0]["source_issue_key"] == "MYAG-105"


def test_feed_json_endpoint_error_returns_502(client, monkeypatch):
    _mock_feed(monkeypatch, error=RuntimeError("boom"))
    resp = client.get("/feed.json")
    assert resp.status_code == 502
    assert "error" in resp.get_json()


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.data == b"ok"


def test_jobs_prefix_mounts_app():
    from werkzeug.test import Client as WerkzeugClient

    wc = WerkzeugClient(wsgi_application)
    resp = wc.get("/jobs/healthz")
    assert resp.status_code == 200
    assert resp.data == b"ok"


def test_root_outside_prefix_is_404():
    from werkzeug.test import Client as WerkzeugClient

    wc = WerkzeugClient(wsgi_application)
    resp = wc.get("/healthz")
    assert resp.status_code == 404


def test_unmounted_path_is_404():
    from werkzeug.test import Client as WerkzeugClient

    wc = WerkzeugClient(wsgi_application)
    resp = wc.get("/nope")
    assert resp.status_code == 404
