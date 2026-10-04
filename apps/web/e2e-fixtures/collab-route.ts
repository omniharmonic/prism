/// <reference path="../src/vite-env.d.ts" />
import { start } from '../src/main';
const params = new URLSearchParams(location.search);
const target = params.get('target') ?? 'Projects/Prism/Shared ideas';
const token = params.get('token');
// ?app → the signed-in workspace itself (sidebar, tabs, embedded live editor), not the /collab share page.
// ?page=<id> → the page link the page menu's "Copy link" produces (`/page/<id>`), through main.tsx's own routing.
const pageId = params.get('page');
history.replaceState(null, '', pageId !== null ? '/page/' + encodeURIComponent(pageId) : params.has('app') ? '/' : '/collab/' + encodeURIComponent(target) + (token ? '?t=' + encodeURIComponent(token) : ''));
void start();
