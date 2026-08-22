#!/usr/bin/env python3
"""
Validate jobs/feed.json against the v1 schema.
Usage:  python validate_feed.py [path/to/feed.json]
Exit:   0 = valid, 1 = invalid
"""
import json
import sys
from pathlib import Path


REQUIRED_FIELDS = {
    "source_issue_id", "source_issue_key", "source_status",
    "title", "company", "salary", "location", "work_arrangement",
    "employment_type", "description", "apply_url", "tailored_resume",
    "ats_score", "ats_breakdown", "created_at", "updated_at",
}
BREAKDOWN_REQUIRED = {
    "skills_match", "experience_match", "education_match",
    "keywords_found", "keywords_missing",
}


def validate(feed: dict) -> list[str]:
    errors: list[str] = []

    if not isinstance(feed, dict):
        return ["Root must be a JSON object"]
    if "schema_version" not in feed:
        errors.append("Missing top-level 'schema_version'")
    if "generated_at" not in feed:
        errors.append("Missing top-level 'generated_at'")
    jobs = feed.get("jobs")
    if not isinstance(jobs, list):
        errors.append("'jobs' must be an array")
        return errors

    for i, job in enumerate(jobs):
        prefix = f"jobs[{i}] ({job.get('source_issue_key', '?')})"

        missing = REQUIRED_FIELDS - set(job.keys())
        if missing:
            errors.append(f"{prefix}: missing fields: {sorted(missing)}")

        if job.get("source_status") != "in_review":
            errors.append(f"{prefix}: source_status must be 'in_review', got {job.get('source_status')!r}")

        score = job.get("ats_score")
        if not isinstance(score, (int, float)) or score < 80:
            errors.append(f"{prefix}: ats_score must be >= 80, got {score!r}")

        url = job.get("apply_url", "")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            errors.append(f"{prefix}: apply_url must be a valid http(s) URL, got {url!r}")

        breakdown = job.get("ats_breakdown", {})
        if not isinstance(breakdown, dict):
            errors.append(f"{prefix}: ats_breakdown must be an object")
        else:
            missing_bd = BREAKDOWN_REQUIRED - set(breakdown.keys())
            if missing_bd:
                errors.append(f"{prefix}: ats_breakdown missing fields: {sorted(missing_bd)}")

    return errors


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "jobs" / "feed.json"
    try:
        with open(path, encoding="utf-8") as f:
            feed = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"ERROR: JSON parse error: {exc}", file=sys.stderr)
        return 1

    errors = validate(feed)
    if errors:
        print(f"INVALID ({len(errors)} error(s)):")
        for e in errors:
            print(f"  - {e}")
        return 1

    job_count = len(feed.get("jobs", []))
    print(f"OK: feed is valid ({job_count} job record(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
