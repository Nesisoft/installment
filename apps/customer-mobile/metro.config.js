// Metro in a pnpm workspace.
//
// Two things need saying, and pnpm is the reason for both:
//
//  1. The app imports workspace packages (@installment/mobile-kit,
//     @installment/api-types) straight from TypeScript source, and pnpm stores
//     their real files outside this directory behind symlinks. Metro only
//     watches its own project root by default, so without the extra watch
//     folder a change in a workspace package never triggers a reload.
//
//  2. Hierarchical lookup must stay ON. pnpm's layout puts each package's own
//     dependencies inside `.pnpm/<pkg>/node_modules`, so resolution has to walk
//     up from a module's REAL path to find them. Disabling it — which is the
//     usual advice for hoisted npm/yarn workspaces — makes Metro look only in
//     the roots listed below and `expo` can then no longer find
//     `expo-modules-core`.
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
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
