# Sounds invariants

- Every write to the `sounds` table (switch, teach, reteach, delete) goes through `changeSoundList` in `sounds.ts`, which runs it in one D1 batch with the `sound_list` version bump. A write outside it leaves sensors on their old list: they refetch only when the version moves.
- The Sounds page drops a list reply whose version is older than the newest it has seen (from a poll or a save's reply), so a poll read before a save cannot flip a switch back. That holds only while every change bumps the version.
