/// <reference path="../src/vite-env.d.ts" />
import { start } from '../src/main';
const params = new URLSearchParams(location.search);
const target = params.get('target') ?? 'Projects/Prism/Shared ideas';
const token = params.get('token');
// ?app → the signed-in workspace itself (sidebar, tabs, embedded live editor), not the /collab share page.
history.replaceState(null, '', params.has('app') ? '/' : '/collab/' + encodeURIComponent(target) + (token ? '?t=' + encodeURIComponent(token) : ''));
void start();
