// Metro in a pnpm workspace: the app imports workspace packages
// (@installment/mobile-kit, @installment/api-types) straight from TypeScript
// source, and pnpm stores their real files outside the app directory behind
// symlinks. Metro only watches its project root by default, so without the
// extra watch folders a change in a workspace package never triggers a reload,
// and without disabling hierarchical lookup pnpm's nested node_modules can
// resolve two copies of React into one bundle.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
