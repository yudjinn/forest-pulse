# Forest Pulse glossary

- **Sensor**: one deployed device: ESP32-S3 audio front-end with three microphones in a 5 cm triangle, plus an Arduino Uno Q that runs the sound model.
- **Sound model**: EfficientAT mn10_as, identical on every sensor. Turns 10 s of audio into built-in label scores and a 960-number embedding.
- **Detector**: a small classifier trained on the embedding for one sound (for example chainsaw, boreal owl). About 4 KB. Alerts come from detectors.
- **Built-in labels**: the sound model's own 527 AudioSet scores (Vehicle, Aircraft, Rain...). Context, not alerts.
- **Sound of interest**: a sound the server tells sensors to report, either a detector or a built-in label.
- **Event**: one report from one sensor: which sound, how confident, when, and the direction measurements.
- **Activity**: what the dashboard shows researchers: a suspected situation (logging, poaching, owl present) built from one or more events.
- **Teaching a sound**: a researcher uploads example recordings, the server trains a detector, sensors pull it.
- **Researcher**: a person signed in to the dashboard.
- **Mic delays**: the three time differences between a sensor's microphones for one sound. Sent in every event; the server turns them into a direction.
- **Facing**: which way a sensor's board points on the plan. Entered on the dashboard for now.
- **Hall background**: a recording of the demo venue that training mixes under every taught sound and uses as an example of what to ignore.
