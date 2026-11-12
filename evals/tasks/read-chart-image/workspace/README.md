# ops

Deployment settings for the shop's services. `deploy/services.json` is read by the rollout job: `scaleUp` and
`scaleDown` ask it to add or remove a replica at the next rollout. Dashboard exports go in `docs/`.
