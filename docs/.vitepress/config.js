import { defineConfig } from 'vitepress';

// THIS FILE IS THE ONE THAT DISAPPEARS.
//
// A bare `config.js` in a global gitignore silently excluded this from
// featureboard's first push. VitePress builds fine without it, so the site
// deployed with no nav and the workflow reported success. Nothing caught it.
// `npm run check-tracked` is what catches it now — see standards/traps.md #1.

export default defineConfig({
  title: 'telemetry',
  description: 'Unified telemetry — product events, errors, traces, state transitions, and billable usage in one Mongo envelope, with typed SDKs and a mountable dashboard.',
  base: '/telemetry/',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['meta', { name: 'theme-color', content: '#2563eb' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'telemetry — Telemetry' }],
    ['meta', { property: 'og:description', content: 'Unified telemetry — product events, errors, traces, state transitions, and billable usage in one Mongo envelope, with typed SDKs and a mountable dashboard.' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/factory' },
      { text: 'GitHub', link: 'https://github.com/JeffJassky/telemetry' },
    ],
    // Every link below must resolve to a real page — VitePress fails the build
    // on a dead link, which is the feature. traps #13.
    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Quickstart', link: '/guide/quickstart' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Modelling',
          items: [
            { text: 'The registry', link: '/guide/registry' },
            { text: 'Data model', link: '/guide/data-model' },
            { text: 'Rollups', link: '/guide/rollups' },
          ],
        },
        {
          text: 'Writing',
          items: [
            { text: 'Emitting records', link: '/guide/emit' },
            { text: 'Ingest & keys', link: '/guide/ingest' },
          ],
        },
        {
          text: 'Reading',
          items: [
            { text: 'Queries & funnels', link: '/guide/queries' },
            { text: 'The dashboard', link: '/guide/dashboard' },
            { text: 'MCP tools', link: '/guide/mcp' },
          ],
        },
        {
          text: 'Operating',
          items: [
            { text: 'Adapters', link: '/guide/adapters' },
            { text: 'Erasure', link: '/guide/erasure' },
            { text: 'Testing', link: '/guide/testing' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API',
          items: [
            { text: 'createTelemetry', link: '/reference/factory' },
            { text: 'Routers', link: '/reference/routers' },
            { text: 'Client SDKs', link: '/reference/client' },
          ],
        },
        {
          text: 'HTTP',
          items: [
            { text: 'Public API', link: '/reference/http-public' },
            { text: 'Admin API', link: '/reference/http-admin' },
          ],
        },
        {
          text: 'Types',
          items: [{ text: 'Types & payloads', link: '/reference/types' }],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/JeffJassky/telemetry' }],
    editLink: {
      pattern: 'https://github.com/JeffJassky/telemetry/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Jeff Jassky',
    },
    search: { provider: 'local' },
  },
});
