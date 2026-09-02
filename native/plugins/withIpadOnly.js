const { withXcodeProject } = require("expo/config-plugins");

// iPad-first: force the iOS target to iPad ONLY (TARGETED_DEVICE_FAMILY = "2").
// The iPad is the scholars' primary (only) device — we never ship an iPhone
// build, so the app should not run in iPhone-compatibility mode. Applied as a
// config plugin so it survives `expo prebuild --clean`.
module.exports = function withIpadOnly(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const buildConfigs = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(buildConfigs)) {
      const entry = buildConfigs[key];
      if (entry && entry.buildSettings && entry.buildSettings.PRODUCT_NAME) {
        entry.buildSettings.TARGETED_DEVICE_FAMILY = '"2"';
      }
    }
    return cfg;
  });
};
