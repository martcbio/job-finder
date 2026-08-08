# JobServe WebServices API — unofficial reference

Reverse-engineered from a captured browsing session
(`careers/misc/jobserve.com.har`, 2026-08-08; 231×200 + 2×302, no fair-use
blocks). The modern JobServe SPA does **not** server-render result rows: it
runs searches through the classic WebForms endpoint and then renders results
and details through ASP.NET ASMX JSON web services. The legacy
server-rendered "Classic View" HTML that this repo's adapter previously
regex-parsed is not served by the current site flow, which is the source of
the stale/garbage-results bug.

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

`POST https://jobserve.com/gb/en/JobSearch.aspx?shid=<sid>&q=<keywords>&lq=United+Kingdom&mk=01&jt=<type>&js=1`

- `Content-Type: application/x-www-form-urlencoded`
- Body carries the WebForms hidden tokens plus the search controls, notably:
  - `ctl00$txtKeyWords=<keywords>`
  - `ctl00$txtLocations=United+Kingdom`
  - `selAge=7`, `selRad=50`, `CHECKBOX01=on` (salary bands all on), `selJType=15`
- Responds `302` with `Location: /gb/en/JobSearch.aspx?shid=<sid>&src=<hash>`.

`GET` the 302 location. The page embeds the full result-set job IDs in:

```html
<input id="ctl00_main_jobIDs" value="ID1#ID2#ID3#..." />
```

(55 IDs in the reference capture; `resSize=100` is the requested pool cap.)

## 2. Render result rows

`POST https://jobserve.com/WebServices/JobSearch.asmx/RetrieveJobs?shid=<sid>`

```json
{ "jobIDsStr": "ID1#ID2#...#ID25", "pageNum": "1" }
```

Response `{"d": "<div class=\"jobItem\" id=\"...\"><h3 class=\"jobResultsTitle\">...</h3><p class=\"jobResultsSalary\">...</p><p class=\"jobResultsLoc\">...</p><p class=\"jobResultsType\">...</p><p class=\"when\">...</p></div>..."}`.

One `.jobItem` per ID. Pagination = slice the `ctl00_main_jobIDs` pool into
25-ID windows and call with `pageNum: N`.

## 3. Full job detail

`POST https://jobserve.com/WebServices/JobSearch.asmx/RetrieveSingleJobDetail`

```json
{ "id": "6254F1931AC08CB43F" }
```

Response `{"d": {"__type": "JobServe.Web.UI.Pages.KeyFunction.WebServices.RetrieveSingleJobDetailResponse", "JobDetailHtml": "<full HTML>", "ChallengeBits": [...], "ChallengeBobs": [...]}}`.

The complete posting (title, salary, location, employer, full description) is
plain text inside `JobDetailHtml`. `ChallengeBits`/`ChallengeBobs` are
present but not required to read the content. Detail URL form:
`/gb/en/W<ID>.jsap` (apply) and `/gb/en/<ID>.jsjob` (detail).

## Supporting endpoints (safe to skip)

- `POST /WebServices/JobSearch.asmx/AddViewedJob` — `{ encJID: "<id>" }`
- `POST /WebServices/JobSearch.asmx/LogCandidateJobView` — `{ jobID: "<id>" }`
- `POST /WebServices/JobSearch.asmx/GetSavedSearchManagerWEmail`
- `POST /WebServices/PageUISettings.asmx/SetStandardListPageUIState`

## Recommended adapter flow

1. GET `JobSearch.aspx` → mint `shid`, tokens, cookies.
2. POST search form → follow 302 → parse `ctl00_main_jobIDs` pool.
3. For each 25-ID page slice: `RetrieveJobs` → rows (title/rate/location/type).
4. For each kept row: `RetrieveSingleJobDetail` → `JobDetailHtml` → markdown.
5. Pace requests (~1.5s) and abort on `usagerestriction.aspx` / fair-use text.
