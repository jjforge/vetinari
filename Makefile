.PHONY: demo-create demo-remove

# Seed / tear down the demo dashboard fixture — a dev fixture, not an operator mode
# (design §12): a set of registered projects that between them render every dashboard
# state, so the status UI can be clicked through without running real agents. Both call
# the same createDemo/removeDemo the coverage test drives, via tsx. `create` is
# idempotent (clear-then-reseed); `remove` deletes only the demo root and its pointers.
demo-create:
	npx tsx scripts/demo.ts create

demo-remove:
	npx tsx scripts/demo.ts remove
