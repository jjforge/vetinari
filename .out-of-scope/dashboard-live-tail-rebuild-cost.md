# Making the dashboard's live tail incremental

vetinari does not plan to make the dashboard's live-tail frame incremental. Today
each frame rebuilds the project's status from the whole event log, once per
debounce window, per open connection.

## Why this is out of scope

The cost is too small to matter. Measured on the largest event log on the
maintainer's host (a 490 KB archive of about 3,700 events), reading the log takes
about 6.5 ms and reducing it about 0.1 ms. A frame costs well under 10 ms against a
300 ms window, even before any caching.

An incremental fold would need a second code path beside `reduceCampaign`, kept in
step with every event the reducer learns. That is real complexity bought for no
visible gain.

Revisit only with a measurement showing a frame's rebuild is a significant share
of its window on a real log.

## Prior requests

- #671 — "The dashboard's live-tail frame re-reads and reduces the whole event log every 300 ms per connection"
