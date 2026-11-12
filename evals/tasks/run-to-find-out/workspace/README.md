# stock-data

Nightly stock records from the warehouses, one JSON file per record in `data/`, and the validator for them:

    python3 tools/validate.py [--profile NAME] DIR

Profiles are in `tools/profiles.toml`; without `--profile` the default one is used, which is what the warehouse
tooling checks locally. The pipeline is in `.ci/`.
