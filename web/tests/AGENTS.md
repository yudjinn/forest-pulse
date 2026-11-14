# Journey harness invariants

- A journey that changes the sound list (switch, teach, reteach, delete) or clears events never runs on the shared service: the other journeys compare its sound list with the seed and read its events. It starts its own service on its own port pair, allocated only in `ports.ts` (base+56 to base+59 are the next free pairs).
