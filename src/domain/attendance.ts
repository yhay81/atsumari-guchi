export type AttendanceChoice = "attending" | "declined" | "interested" | "waitlisted";

export type AttendanceRecord = {
  choice: AttendanceChoice;
  createdAt: number;
  id: string;
  partySize: number;
};

export const countAttendingSeats = (responses: AttendanceRecord[]) =>
  responses
    .filter((response) => response.choice === "attending")
    .reduce((total, response) => total + response.partySize, 0);

export const resolveRequestedChoice = (
  requested: Exclude<AttendanceChoice, "waitlisted">,
  partySize: number,
  capacity: number,
  occupiedSeats: number,
  hasWaitlist = false,
): AttendanceChoice => {
  if (requested !== "attending") return requested;
  if (hasWaitlist) return "waitlisted";
  return occupiedSeats + partySize <= capacity ? "attending" : "waitlisted";
};

export const chooseWaitlistPromotions = (
  responses: AttendanceRecord[],
  capacity: number,
): string[] => {
  let occupied = countAttendingSeats(responses);
  const promoted: string[] = [];
  const queue = responses
    .filter((response) => response.choice === "waitlisted")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  for (const response of queue) {
    if (occupied + response.partySize > capacity) break;
    promoted.push(response.id);
    occupied += response.partySize;
  }
  return promoted;
};
