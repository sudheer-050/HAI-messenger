import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app import _validate


def _base_job(**overrides):
    job = {
        "source_issue_id":  "00000000-0000-0000-0000-000000000001",
        "source_issue_key": "MYAG-105",
        "source_status":    "in_review",
        "title":            "ML Engineer",
        "company":          "Acme",
        "salary":           "Not disclosed",
        "location":         "Remote",
        "work_arrangement": "Remote",
        "employment_type":  "Full-time",
        "description":      "Build ML models.",
        "apply_url":        "https://acme.com/jobs/1",
        "tailored_resume":  "Sudheer is great at ML.",
        "ats_score":        85,
        "ats_breakdown": {
            "skills_match":     90,
            "experience_match": 80,
            "education_match":  85,
            "keywords_found":   ["Python"],
            "keywords_missing": [],
        },
        "created_at":  "2026-08-22T00:00:00Z",
        "updated_at":  "2026-08-22T00:00:00Z",
    }
    job.update(overrides)
    return job


def _valid_feed(*jobs):
    return {
        "schema_version": "1.0",
        "generated_at":   "2026-08-22T00:00:00Z",
        "jobs":           list(jobs),
    }


def test_empty_feed_is_valid():
    result = _validate({"schema_version": "1.0", "generated_at": "2026-08-22T00:00:00Z", "jobs": []})
    assert result["jobs"] == []


def test_valid_job_passes_through():
    job = _base_job()
    result = _validate(_valid_feed(job))
    assert len(result["jobs"]) == 1
    assert result["jobs"][0]["source_issue_key"] == "MYAG-105"


def test_backlog_job_excluded():
    job = _base_job(source_status="backlog")
    result = _validate(_valid_feed(job))
    assert result["jobs"] == []


def test_sub_threshold_score_excluded():
    job = _base_job(ats_score=79)
    result = _validate(_valid_feed(job))
    assert result["jobs"] == []


def test_exact_threshold_included():
    job = _base_job(ats_score=80)
    result = _validate(_valid_feed(job))
    assert len(result["jobs"]) == 1


def test_missing_apply_url_excluded():
    job = _base_job(apply_url="")
    result = _validate(_valid_feed(job))
    assert result["jobs"] == []


def test_non_http_apply_url_excluded():
    job = _base_job(apply_url="ftp://bad.example.com")
    result = _validate(_valid_feed(job))
    assert result["jobs"] == []


def test_missing_required_field_excluded():
    job = _base_job()
    del job["tailored_resume"]
    result = _validate(_valid_feed(job))
    assert result["jobs"] == []


def test_malformed_record_excluded():
    result = _validate(_valid_feed("not-a-dict"))
    assert result["jobs"] == []


def test_mixed_feed_keeps_only_valid():
    good = _base_job()
    bad_status = _base_job(source_status="backlog")
    bad_score  = _base_job(ats_score=50)
    result = _validate(_valid_feed(good, bad_status, bad_score))
    assert len(result["jobs"]) == 1


def test_feed_root_must_be_dict():
    with pytest.raises(ValueError):
        _validate([{"jobs": []}])


def test_jobs_must_be_list():
    with pytest.raises(ValueError):
        _validate({"schema_version": "1.0", "generated_at": "", "jobs": "oops"})
