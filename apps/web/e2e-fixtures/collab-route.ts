/// <reference path="../src/vite-env.d.ts" />
import { start } from '../src/main';
const params = new URLSearchParams(location.search);
const target = params.get('target') ?? 'Projects/Prism/Shared ideas';
const token = params.get('token');
history.replaceState(null, '', '/collab/' + encodeURIComponent(target) + (token ? '?t=' + encodeURIComponent(token) : ''));
void start();
