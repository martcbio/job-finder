export const SEARCH_ENGINES = [
  "google",
  "duckduckgo",
  "bing",
  "yahoo",
  "kagi",
  "qwant",
  "brave",
  "startpage",
] as const;

export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export const TIME_FILTERS = [
  "all",
  "1hour",
  "4hours",
  "8hours",
  "12hours",
  "24hours",
  "48hours",
  "72hours",
  "week",
  "month",
  "year",
  "older1month",
  "older3months",
  "older6months",
] as const;

export type TimeFilter = (typeof TIME_FILTERS)[number];

export function isSearchEngine(value: string): value is SearchEngine {
  return SEARCH_ENGINES.includes(value as SearchEngine);
}

export function isTimeFilter(value: string): value is TimeFilter {
  return TIME_FILTERS.includes(value as TimeFilter);
}

function isOlderThanFilter(timeFilter: TimeFilter): boolean {
  return ["older1month", "older3months", "older6months"].includes(timeFilter);
}

function getMonthsBackForOlderFilter(timeFilter: TimeFilter): number | null {
  switch (timeFilter) {
    case "older1month":
      return 1;
    case "older3months":
      return 3;
    case "older6months":
      return 6;
    default:
      return null;
  }
}

function getPastDate(monthsBack: number): string {
  const today = new Date();
  const pastDate = new Date(today);
  pastDate.setMonth(today.getMonth() - monthsBack);

  const mm = String(pastDate.getMonth() + 1).padStart(2, "0");
  const dd = String(pastDate.getDate()).padStart(2, "0");
  const yyyy = pastDate.getFullYear();

  return `${mm}/${dd}/${yyyy}`;
}

function getPastDateISO(monthsBack: number): string {
  const today = new Date();
  const pastDate = new Date(today);
  pastDate.setMonth(today.getMonth() - monthsBack);

  const yyyy = pastDate.getFullYear();
  const mm = String(pastDate.getMonth() + 1).padStart(2, "0");
  const dd = String(pastDate.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

function addOlderThanQueryOperator(query: string, timeFilter: TimeFilter): string {
  const monthsBack = getMonthsBackForOlderFilter(timeFilter);
  if (!monthsBack) return query;
  return `${query} before:${getPastDateISO(monthsBack)}`;
}

function getGoogleTimeParam(timeFilter: TimeFilter): string {
  switch (timeFilter) {
    case "24hours":
      return "&tbs=qdr:d";
    case "48hours":
      return "&tbs=qdr:h48";
    case "72hours":
      return "&tbs=qdr:h72";
    case "1hour":
      return "&tbs=qdr:h1";
    case "4hours":
      return "&tbs=qdr:h4";
    case "8hours":
      return "&tbs=qdr:h8";
    case "12hours":
      return "&tbs=qdr:h12";
    case "week":
      return "&tbs=qdr:w";
    case "month":
      return "&tbs=qdr:m";
    case "year":
      return "&tbs=qdr:y";
    case "older1month":
      return `&tbs=cdr:1,cd_max:${getPastDate(1)}`;
    case "older3months":
      return `&tbs=cdr:1,cd_max:${getPastDate(3)}`;
    case "older6months":
      return `&tbs=cdr:1,cd_max:${getPastDate(6)}`;
    default:
      return "";
  }
}

function getStartpageAfterDate(timeFilter: TimeFilter): string {
  const dayMap: Partial<Record<TimeFilter, number>> = {
    "24hours": 1,
    week: 7,
    month: 30,
    year: 365,
  };
  const days = dayMap[timeFilter];
  if (!days) return "";

  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function buildSearchEngineUrl(
  engine: SearchEngine,
  query: string,
  timeFilter: TimeFilter,
): string {
  const queryWithOlderThan = addOlderThanQueryOperator(query, timeFilter);

  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${encodeURIComponent(query)}${getGoogleTimeParam(timeFilter)}`;
    case "duckduckgo": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "d",
        week: "w",
        month: "m",
        year: "y",
      };
      const df = map[timeFilter];
      const dfParam = df ? `&df=${df}` : "";
      return `https://duckduckgo.com/html/?q=${encodeURIComponent(queryWithOlderThan)}${dfParam}`;
    }
    case "bing": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "ez1",
        week: "ez2",
        month: "ez3",
      };
      const code = map[timeFilter];
      const filterParam = code ? `&filters=ex1%3a%22${code}%22` : "";
      return `https://www.bing.com/search?q=${encodeURIComponent(queryWithOlderThan)}${filterParam}`;
    }
    case "yahoo": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "d",
        week: "w",
        month: "m",
      };
      const code = map[timeFilter];
      const filterParam = code ? `&fr2=time&btf=${code}&fr=sfp` : "";
      return `https://search.yahoo.com/search?p=${encodeURIComponent(queryWithOlderThan)}${filterParam}`;
    }
    case "kagi": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "1",
        week: "2",
        month: "3",
        year: "4",
      };
      const code = map[timeFilter];
      const filterParam = code ? `&dr=${code}` : "";
      return `https://kagi.com/search?q=${encodeURIComponent(queryWithOlderThan)}${filterParam}`;
    }
    case "qwant": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "day",
        week: "week",
        month: "month",
      };
      const code = map[timeFilter];
      const filterParam = code ? `&freshness=${code}` : "";
      return `https://www.qwant.com/?q=${encodeURIComponent(queryWithOlderThan)}&t=web${filterParam}`;
    }
    case "brave": {
      const map: Partial<Record<TimeFilter, string>> = {
        "24hours": "pd",
        week: "pw",
        month: "pm",
        year: "py",
      };
      const code = map[timeFilter];
      const filterParam = code ? `&tf=${code}` : "";
      return `https://search.brave.com/search?q=${encodeURIComponent(queryWithOlderThan)}&source=web${filterParam}`;
    }
    case "startpage": {
      if (isOlderThanFilter(timeFilter)) {
        return `https://www.startpage.com/sp/search?query=${encodeURIComponent(queryWithOlderThan)}`;
      }

      const afterDate = getStartpageAfterDate(timeFilter);
      const fullQuery = afterDate ? `${queryWithOlderThan} after:${afterDate}` : queryWithOlderThan;
      return `https://www.startpage.com/sp/search?query=${encodeURIComponent(fullQuery)}`;
    }
  }
}
