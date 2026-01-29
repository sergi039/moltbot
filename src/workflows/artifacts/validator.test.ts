import { describe, it, expect } from "vitest";

import { evaluateCondition } from "./validator.js";

describe("evaluateCondition", () => {
  describe("simple property access", () => {
    it("should evaluate $.approved == true", () => {
      const artifacts = { approved: true };
      expect(evaluateCondition("$.approved == true", artifacts)).toBe(true);
      expect(evaluateCondition("$.approved == false", artifacts)).toBe(false);
    });

    it("should evaluate $.approved == false", () => {
      const artifacts = { approved: false };
      expect(evaluateCondition("$.approved == false", artifacts)).toBe(true);
      expect(evaluateCondition("$.approved == true", artifacts)).toBe(false);
    });

    it("should evaluate numeric comparisons", () => {
      const artifacts = { score: 75 };
      expect(evaluateCondition("$.score > 70", artifacts)).toBe(true);
      expect(evaluateCondition("$.score < 70", artifacts)).toBe(false);
      expect(evaluateCondition("$.score >= 75", artifacts)).toBe(true);
      expect(evaluateCondition("$.score <= 75", artifacts)).toBe(true);
    });
  });

  describe("nested property access", () => {
    it("should evaluate $.planReview.approved == false", () => {
      const artifacts = {
        planReview: { approved: false, score: 60 },
      };
      expect(evaluateCondition("$.planReview.approved == false", artifacts)).toBe(true);
      expect(evaluateCondition("$.planReview.approved == true", artifacts)).toBe(false);
    });

    it("should evaluate $.planReview.approved == true", () => {
      const artifacts = {
        planReview: { approved: true, score: 85 },
      };
      expect(evaluateCondition("$.planReview.approved == true", artifacts)).toBe(true);
      expect(evaluateCondition("$.planReview.approved == false", artifacts)).toBe(false);
    });

    it("should evaluate deeply nested paths", () => {
      const artifacts = {
        result: {
          review: {
            approved: true,
          },
        },
      };
      expect(evaluateCondition("$.result.review.approved == true", artifacts)).toBe(true);
    });

    it("should return false for missing nested property", () => {
      const artifacts = { planReview: {} };
      // undefined == false is false in strict comparison
      expect(evaluateCondition("$.planReview.approved == false", artifacts)).toBe(false);
    });
  });

  describe("array filter with length", () => {
    it("should evaluate $.review.issues[...].length > 0 with critical issues", () => {
      const artifacts = {
        review: {
          approved: false,
          issues: [
            { id: "1", severity: "critical", description: "Bug" },
            { id: "2", severity: "low", description: "Style" },
          ],
        },
      };
      expect(
        evaluateCondition("$.review.issues[?(@.severity=='critical')].length > 0", artifacts),
      ).toBe(true);
    });

    it("should evaluate $.review.issues[...].length > 0 without critical issues", () => {
      const artifacts = {
        review: {
          approved: true,
          issues: [
            { id: "1", severity: "low", description: "Style" },
            { id: "2", severity: "medium", description: "Perf" },
          ],
        },
      };
      expect(
        evaluateCondition("$.review.issues[?(@.severity=='critical')].length > 0", artifacts),
      ).toBe(false);
    });

    it("should evaluate $.review.issues[...].length == 0", () => {
      const artifacts = {
        review: {
          approved: true,
          issues: [],
        },
      };
      expect(
        evaluateCondition("$.review.issues[?(@.severity=='critical')].length == 0", artifacts),
      ).toBe(true);
    });

    it("should evaluate with != filter operator", () => {
      const artifacts = {
        review: {
          issues: [
            { id: "1", severity: "critical", description: "Bug" },
            { id: "2", severity: "low", description: "Style" },
          ],
        },
      };
      // Count non-critical issues
      expect(
        evaluateCondition("$.review.issues[?(@.severity!='critical')].length > 0", artifacts),
      ).toBe(true);
    });

    it("should return false when array is missing", () => {
      const artifacts = { review: {} };
      expect(
        evaluateCondition("$.review.issues[?(@.severity=='critical')].length > 0", artifacts),
      ).toBe(false);
    });
  });

  describe("direct array filter (without nested base)", () => {
    it("should evaluate $.issues[...].length directly", () => {
      const artifacts = {
        issues: [{ severity: "critical" }, { severity: "low" }],
      };
      expect(evaluateCondition("$.issues[?(@.severity=='critical')].length > 0", artifacts)).toBe(
        true,
      );
    });
  });

  describe("edge cases", () => {
    it("should return false for unknown conditions", () => {
      const artifacts = {};
      expect(evaluateCondition("unknown syntax here", artifacts)).toBe(false);
    });

    it("should return false for missing top-level property", () => {
      const artifacts = {};
      expect(evaluateCondition("$.missing.property == true", artifacts)).toBe(false);
    });
  });
});
