import { describe, expect, test } from "bun:test";
import type { AtsOrgJob } from "../../services/ats/types";
import { classifyLabOpening, classifyLocation } from "../labOpeningDecisions";

function opening(title: string): AtsOrgJob {
  return {
    source: "greenhouse",
    org: "lab",
    id: title,
    title,
    location: "London, UK",
    locations: ["London, UK"],
    url: "https://example.test/job",
    postedAt: null,
    raw: {},
  };
}

describe("lab opening decisions", () => {
  test.each([
    ["Field Marketing Lead", "role.marketing"],
    ["AI Support Engineer", "role.support"],
    ["Security and Compliance Manager", "role.security_management"],
    ["Communications Lead, Infrastructure and Engineering", "role.communications"],
    ["Product Manager, Agent Development", "role.management"],
    ["Data Center Electrical Engineer", "role.physical_infrastructure"],
  ])("keeps obviously unsuitable %s roles out of the review queue", (title, reasonCode) => {
    expect(classifyLabOpening(opening(title))).toMatchObject({
      roleRelevance: { status: "irrelevant", reasonCodes: [reasonCode] },
      disposition: "unsuitable_role",
    });
  });

  test("lists a technical role but disqualifies it when the ATS body requires Mandarin", () => {
    const job = opening("AI Success Engineer");
    job.location = "Singapore";
    job.locations = ["Singapore"];
    job.raw = {
      descriptionPlain:
        "Serve as the technical advisor for customer implementations. You might thrive in this role if you are fluent in Mandarin.",
    };

    expect(classifyLabOpening(job)).toMatchObject({
      locationEligibility: { status: "eligible" },
      roleRelevance: {
        status: "irrelevant",
        reasonCodes: ["role.language_requirement"],
      },
      disposition: "unsuitable_role",
    });
  });

  test("keeps the ATS location policy aligned with accepted non-US work locations", () => {
    const job = opening("AI Support Engineer");
    job.location = "Singapore";
    job.locations = ["Singapore"];

    expect(classifyLabOpening(job).locationEligibility).toEqual({
      status: "eligible",
      reasonCodes: ["location.accepted_non_us"],
    });
  });

  test.each([
    "Zurich, Switzerland",
    "Milan, Italy",
    "Warsaw, Poland",
    "Lisbon, Portugal",
    "Copenhagen, Denmark",
    "Oslo, Norway",
    "Helsinki, Finland",
    "Vienna, Austria",
    "Prague, Czech Republic",
  ])("recognises a relevant European location: %s", (location) => {
    const job = opening("Software Engineer");
    job.location = location;
    job.locations = [location];

    expect(classifyLocation(job).status).toBe("eligible");
  });

  test("does not mistake ordinary words for US state abbreviations", () => {
    const job = opening("Software Engineer");
    job.location = "Remote or hybrid";
    job.locations = ["Remote or hybrid"];

    expect(classifyLocation(job)).toEqual({
      status: "undecided",
      reasonCodes: ["location.unrecognized"],
    });
  });

  test("does not mistake Canada's country code for California", () => {
    const job = opening("Software Engineer");
    job.location = "Toronto, CA";
    job.locations = ["Toronto, CA"];

    expect(classifyLocation(job)).toEqual({
      status: "undecided",
      reasonCodes: ["location.unrecognized"],
    });
  });
});
