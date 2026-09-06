/** Expo's preset already covers Expo Router and Reanimated (worklets plugin). */
module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: [['babel-preset-expo', { reanimated: true }]] };
};
