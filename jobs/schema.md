# Job Feed Schema — v1

**Feed file:** `jobs/feed.json` in this repository  
**Public raw URL:** `https://raw.githubusercontent.com/sudheer-050/HAI-messenger/master/jobs/feed.json`

## Top-level envelope

```json
{
  "schema_version": "1.0",
  "generated_at": "<ISO-8601 UTC timestamp>",
  "jobs": [ ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `schema_version` | string | Feed format version; consumers must reject unknown major versions |
| `generated_at` | string (ISO-8601) | UTC timestamp of last feed write |
| `jobs` | array | Ordered list of qualified job records (most recent first) |

## Job record

```json
{
  "source_issue_id":  "<Multica UUID>",
  "source_issue_key": "MYAG-105",
  "source_status":    "in_review",
  "title":            "Machine Learning Engineer",
  "company":          "Acme Corp",
  "salary":           "Not disclosed",
  "location":         "Austin, TX",
  "work_arrangement": "Remote",
  "employment_type":  "Full-time",
  "description":      "<full job description text>",
  "apply_url":        "https://company.com/careers/apply/12345",
  "tailored_resume":  "<tailored resume markdown text>",
  "ats_score":        85,
  "ats_breakdown": {
    "skills_match":     90,
    "experience_match": 80,
    "education_match":  85,
    "keywords_found":   ["Python", "machine learning", "SQL"],
    "keywords_missing": ["Scala"],
    "notes":            "Strong match on core ML stack."
  },
  "created_at":  "<ISO-8601 UTC>",
  "updated_at":  "<ISO-8601 UTC>"
}
```

### Field definitions

| Field | Type | Required | Notes |
|---|---|---|---|
| `source_issue_id` | string (UUID) | yes | Multica issue UUID; used as deduplication key for upserts |
| `source_issue_key` | string | yes | Human-readable Multica identifier, e.g. `MYAG-105` |
| `source_status` | string | yes | Must be `"in_review"` — feed may only contain in_review records |
| `title` | string | yes | Job title |
| `company` | string | yes | Employer name |
| `salary` | string | yes | Salary range, or `"Not disclosed"` if absent from posting |
| `location` | string | yes | City/state/country or `"Remote"` |
| `work_arrangement` | string | yes | `"Remote"`, `"Hybrid"`, or `"Onsite"` |
| `employment_type` | string | yes | `"Full-time"`, `"Part-time"`, `"Contract"`, or `"Internship"` |
| `description` | string | yes | Full job description text |
| `apply_url` | string (URL) | yes | Official company/ATS application URL; must be non-empty `http(s)://` |
| `tailored_resume` | string | yes | Resume text tailored for this job by the Resume Tailor agent |
| `ats_score` | integer | yes | ATS match score 0–100; must be >= 80 to appear in feed |
| `ats_breakdown` | object | yes | Sub-scores and keyword analysis (see below) |
| `created_at` | string (ISO-8601) | yes | When this record was first written to the feed |
| `updated_at` | string (ISO-8601) | yes | When this record was last updated |

### `ats_breakdown` fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `skills_match` | integer | yes | 0–100 skills alignment score |
| `experience_match` | integer | yes | 0–100 experience alignment score |
| `education_match` | integer | yes | 0–100 education alignment score |
| `keywords_found` | array of strings | yes | Keywords from job description found in resume |
| `keywords_missing` | array of strings | yes | Keywords from job description absent from resume |
| `notes` | string | no | Free-form recruiter-style commentary |

## Validation rules

A record is **rejected** (not written to the feed) if any of the following are true:

1. `source_status` is not `"in_review"`
2. `ats_score` < 80
3. `apply_url` is missing, empty, or does not start with `http://` or `https://`
4. Any required field is missing or null
5. `ats_score` is not an integer in 0–100

## Upsert semantics

Writers use `source_issue_id` as the stable key:
- If a record with that `source_issue_id` already exists, **replace** it and update `updated_at`.
- If no record exists, **insert** it and set both `created_at` and `updated_at`.
- After writing, sort `jobs` by `updated_at` descending (most recently updated first).

## What the feed must NEVER contain

- Multica API tokens or credentials
- Private reference resume data (only the *tailored* resume text for the specific qualified listing is allowed)
- Jobs with `source_status` other than `"in_review"`
- Jobs with `ats_score` < 80
- Jobs without a valid official `apply_url`
