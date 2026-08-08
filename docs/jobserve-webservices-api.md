# JobServe WebServices API — unofficial reference

Reverse-engineered from a captured browsing session
(`careers/misc/jobserve.com.har`, 2026-08-08; 231×200 + 2×302, no fair-use
blocks). JobServe serves two views:

- **Classic view** (`JobListing.aspx`): server-renders each result page's
  `.jobListItem` rows directly (20 per page, paginated via `nav_Next`). This
  is what an HTTP adapter receives after submitting the search form, and it
  is the reliable list path.
- **Enhanced view** (`JobSearch.aspx`): an SPA that renders rows client-side
  through the `RetrieveJobs` web service. An HTTP client cannot reach this
  without the `jobIDs` pool the SPA builds; the HAR documents it for
  completeness.

The **detail web service** (`RetrieveSingleJobDetail`) works in both views
and returns the full posting in one JSON call — this is the reliable detail
path. The legacy adapter's failure mode was fetching the server-rendered
"Classic View" URL a second time after the search POST and losing the search
state, then regex-parsing the wrong (stale) listing.

All web-service calls require:

- `Content-Type: application/json; charset=UTF-8`
- `X-Requested-With: XMLHttpRequest`
- `Origin: https://jobserve.com` (and matching `Referer`)
- the session id as a query param: `?shid=<sid>`
- an ASMX response envelope of `{"d": ...}`

Fair-use remains enforced server-side (`/gb/en/usagerestriction.aspx`).
Keep pacing and abort-on-restriction (`requestPacer.ts`,
`jobservePageSignals.ts`).

## Session setup

`GET https://jobserve.com/gb/en/JobSearch.aspx`

Mints the `shid` (appears in the URL after the first load) and the
`__VIEWSTATE` / `__VIEWSTATEGENERATOR` / `__EVENTVALIDATION` tokens required
for the search POST. Cookies + tokens must be reused for the whole session.

## 1. Execute a search (WebForms POST)

`POST /gb/en/JobSearch.aspx?shid=<sid>&q=<keywords>&lq=United+Kingdom&mk=01&jt=<type>&js=1`

- `Content-Type: application/x-www-form-urlencoded`
- Body carries the WebForms hidden tokens plus the search controls, notably:
  - `ctl00$txtKeyWords=<keywords>`
  - `ctl00$txtLocations=United+Kingdom`
  - `selAge=7`, `selRad=50`, `CHECKBOX01=on` (salary bands all on), `selJType=15`
- Responds `302` to the results page, which server-renders the first page of
  `.jobListItem` rows directly.

## 2. Result rows (classic view)

Parse `.jobListItem` blocks from the search-POST response. Each block has:

- `a.jobListPosition` — title + permalink
- `a.jobListApply` — apply URL
- `p.jobListSkills` — summary + the `more ->` detail link
- `label.jobListLabel`/`span.jobListDetail` pairs — Location, Rate, Type,
  Industry, Employment Business, Posted Date, Duration, Reference

Pagination follows the `<span class="nav_Next"><a href="...&page=N">` link.

(The enhanced view instead embeds the result-set IDs in
`<input id="jobIDs" value="ID#ID#...">` and renders rows by POSTing
`RetrieveJobs` with 25-ID slices: `{ jobIDsStr: "ID1#...", pageNum: "1" }`,
receiving `{"d": "<div class=jobItem id=...>...jobResultsTitle...>"}`. Kept
for reference; an HTTP adapter should use the classic server-rendered path.)

## 3. Full job detail (WebService)

`POST /WebServices/JobSearch.asmx/RetrieveSingleJobDetail`

```json
{ "id": "6254F1931AC08CB43F" }
```

Response `{"d": {"__type": "JobServe.Web.UI.Pages.KeyFunction.WebServices.RetrieveSingleJobDetailResponse", "JobDetailHtml": "<full HTML>", "ChallengeBits": [...], "ChallengeBobs": [...]}}`.

The complete posting (title, salary, location, employer, full description) is
plain text inside `JobDetailHtml`:
- title: `#positiontitle`
- location/salary: `.td_location_salary`
- job type: `.td_job_type`
- employer: `Posted by:` label in `.td_posted_by`
- posted date: `.td_posted_date` (`Wednesday, 5 August 2026`)
- description: `#md_skills`

`ChallengeBits`/`ChallengeBobs` are present but not required to read the
content. The response should be verified to reference the requested job id.
Detail URL forms: `/gb/en/W<ID>.jsap` (apply) and `/gb/en/W<ID>.jsjob`.

## Supporting endpoints (safe to skip)

- `POST /WebServices/JobSearch.asmx/AddViewedJob` — `{ encJID: "<id>" }`
- `POST /WebServices/JobSearch.asmx/LogCandidateJobView` — `{ jobID: "<id>" }`
- `POST /WebServices/JobSearch.asmx/GetSavedSearchManagerWEmail`
- `POST /WebServices/PageUISettings.asmx/SetStandardListPageUIState`

## Recommended adapter flow

1. GET `JobSearch.aspx` → mint `shid`, tokens, cookies.
2. POST search form → follow 302 → parse the server-rendered `.jobListItem`
   rows from the response (do not re-fetch the results URL).
3. Paginate via `nav_Next` links.
4. For each kept row: `RetrieveSingleJobDetail` → `JobDetailHtml` → markdown.
5. Pace requests (~1.5s) and abort on `usagerestriction.aspx` / fair-use text.
