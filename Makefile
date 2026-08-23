# Convenience targets for the demo dashboard project (acme-checkout) — the
# repeatable fixture used to click through the status UI. Both wrap
# scripts/seed-demo-dashboard.mts; refresh the running dashboard afterwards.
.PHONY: demo-create demo-clean gateway-restart

# Seed + register the demo 'acme-checkout' project into the local dashboard.
demo-create:
	npx tsx scripts/seed-demo-dashboard.mts

# Unregister + delete it (removes ~/.cache/sctdd-demo and its registry pointer).
demo-clean:
	npx tsx scripts/seed-demo-dashboard.mts --clear

# Restart the host gateway systemd user service so it serves the current code
# (tsx compiles at startup, so a restart is how merged changes go live).
gateway-restart:
	systemctl --user restart sandcastle-gateway.service
	@systemctl --user is-active sandcastle-gateway.service
