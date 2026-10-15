// Provider unit tests must not silently depend on an optional developer cache.
// Worldwide catalogue tests explicitly install their own source fixture.
process.env.GLOBAL_LOCATION_CATALOGUE_PATH ||= new URL('./fixtures/not-installed.sqlite', import.meta.url).pathname;
