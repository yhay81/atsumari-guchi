import { describe, expect, it } from "vitest";

import {
  chooseWaitlistPromotions,
  countAttendingSeats,
  resolveRequestedChoice,
  type AttendanceRecord,
} from "../src/domain/attendance";

const record = (
  id: string,
  choice: AttendanceRecord["choice"],
  partySize: number,
  createdAt: number,
): AttendanceRecord => ({ choice, createdAt, id, partySize });

describe("attendance capacity", () => {
  it("counts only attending seats", () => {
    expect(
      countAttendingSeats([
        record("a", "attending", 2, 1),
        record("b", "waitlisted", 4, 2),
        record("c", "interested", 3, 3),
        record("d", "attending", 1, 4),
      ]),
    ).toBe(3);
  });

  it("accepts an attending request only when the entire party fits", () => {
    expect(resolveRequestedChoice("attending", 2, 6, 4)).toBe("attending");
    expect(resolveRequestedChoice("attending", 3, 6, 4)).toBe("waitlisted");
    expect(resolveRequestedChoice("interested", 4, 2, 2)).toBe("interested");
    expect(resolveRequestedChoice("declined", 4, 2, 2)).toBe("declined");
  });

  it("does not let a later small party jump an existing waitlist", () => {
    expect(resolveRequestedChoice("attending", 1, 10, 3, true)).toBe("waitlisted");
  });

  it("promotes the waitlist in FIFO order without splitting parties", () => {
    const responses = [
      record("attending", "attending", 2, 1),
      record("first", "waitlisted", 2, 2),
      record("second", "waitlisted", 1, 3),
    ];
    expect(chooseWaitlistPromotions(responses, 5)).toEqual(["first", "second"]);
  });

  it("stops at the first party that does not fit", () => {
    const responses = [
      record("attending", "attending", 3, 1),
      record("first", "waitlisted", 3, 2),
      record("second", "waitlisted", 1, 3),
    ];
    expect(chooseWaitlistPromotions(responses, 5)).toEqual([]);
  });
});
