# Country eligibility for fetched jobs

The existing search location filter treats `Remote` as sufficient even when a
posting restricts hiring to another country. It also unconditionally accepts
RemoteOK and WeWorkRemotely jobs. WeWorkRemotely's parser writes `Remote` as
every job's location, and some RemoteOK postings have an empty location. Real
postings consequently reach a US inbox with descriptions such as “only
considering candidates based in South Africa, Latin America, or Eastern Europe.”

Search locations describe where to search; remote work does not establish where
the employer hires. Adding `LATAM` to keyword exclusions is insufficient: some
postings accept both US and LATAM residents, and some mention LATAM customers
without restricting employee residence.

## Patch

Set **Settings → Job Search → Hiring country** to `United States`, or configure:

```yaml
search:
  hiring_country: United States
```

Blank disables the gate and preserves existing behavior. This is a hiring
country check, not citizenship, visa sponsorship, clearance, or city/state
eligibility verification. Existing search locations still constrain discovery.

The fetched schemas don't expose a consistent, authoritative eligible-country
field. The gate uses the existing utility AI tier (and its existing fast-tier
fallback) to read the title, location, and full description. It sends no applicant
profile. It batches up to four jobs per request with three concurrent requests
and bounds each call to 75 seconds. JSON response mode is required of the
configured OpenAI-compatible endpoint.

Only an `eligible` result with a verbatim evidence quote reaches persistence
and later scoring. `ineligible` and `unknown` results are held out. A missing AI
configuration, provider error, malformed output, unverified quote, contradictory
geography, or description above the context budget cannot silently admit a job.
This deliberately trades recall for a cleaner inbox; generic “Remote” postings
without hiring geography can be withheld even if the employer actually hires
in the target country. The LLM can still misinterpret valid text; evidence makes
decisions inspectable rather than guaranteeing employer eligibility.

The gate lives at `_bg_fetch_jobs`' save boundary, covering Fetch, Fetch & Score,
and partial results recovered after the outer fetch timeout. It does not alter
existing records or manually added jobs. No schema migration, new API key, or
additional dependency is needed.

The completion message includes excluded/unverified counts. The authenticated
`GET /api/jobs/country-filter/report` endpoint and the Settings link show the
last run, with job links and evidence. Runtime files live under `data/`:

- `country_filter_report.json`: last run's eligible, ineligible and unknown jobs.
- `country_filter_cache.json`: up to 5,000 evidenced decisions keyed by posting
  content, country, AI configuration and policy version. Unknowns/errors retry
  on the next fetch. Delete the cache to force a recheck.

Repeated unchanged jobs reuse the cached decision. A changed description,
country, AI configuration or policy version forces reclassification. Larger
fetches add AI latency and usage; the initial preview uses a representative
sample rather than reclassifying the entire historical inbox.

## Verification

```sh
python -m pytest tests/test_country_eligibility.py tests/job_sources -q
npm run test:frontend
```

The regression reproduces a real foreign-only remote posting and asserts that
it never reaches `db.upsert_job`, both on normal fetch and timeout recovery.
Further tests cover supported US/worldwide decisions, unsupported evidence,
unknowns, outages, disabled configuration, cancellation, invalid/duplicate IDs,
context limits, and cache invalidation.
