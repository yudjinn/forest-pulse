# Sensors and plan invariants

- Online is judged only by `isOnline` in `plan.ts`, on the service's clock at read time, and reaches the dashboard as the `online` field. A second copy of the 10 s rule (in the browser, or in another capability's module) reads a different clock and the plan and that capability disagree about the same sensor.
- A new sensor's default spot is chosen inside the one `INSERT ... SELECT` statement in `placeOnCheckin`. Splitting it into a read and then an insert lets two first check-ins arriving together land on the same spot.
- Every path that changes a sensor's placement by hand (move, nudge, facing, removal) runs `clearMeasuredMark` (`calibration/layout.ts`) in the same batch as its update. A path without it leaves "Calibrated" and the measured distances on a plan a researcher has since rearranged. Calibration's own apply writes placements directly and is the only writer that keeps the mark.
