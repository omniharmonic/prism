# D06 studio presentation follow-up

Source checkpoint `5836006`, following the isolated navigation checkpoint `c17d357`. The navigation contract/release prerequisite in `PUBLICATION-NAVIGATION-VERIFICATION.md` still applies to this branch. No deployment, backend changes or native build occurred here.

## Changes against board24 and the visual audit

- The collection header keeps the actual currently visible page count in view. Site address/copy and automatic-membership explanations remain accessible in a native expandable row, reducing repeated chrome above the studio.
- Appearance removes the duplicate cross-section explanation while retaining the specific private-draft/explicit-publish/live-document explanation in Site studio. Live revision stays beside the heading; narrower screens can pair action buttons.
- Below the existing 800px studio container boundary, **Settings view** and **Preview view** switch presentation without unmounting either the form or the requested preview. Changing views alone makes no preview request. Desktop continues to show both columns.
- Unsaved appearance fields, navigation edits, the saved iframe, and revision state survive switching and resizing. A visible notice beside the preview distinguishes unsaved settings from its saved revision. Closing a dirty inline preview returns to the settings input; normal view switches retain focus on the selected control.

The approved board remains a visual direction, not a reason to invent blog/portfolio templates, remote photos or extra navigation APIs. The preview remains the real wiki/docs/landing renderer. At the tested 1280px desktop viewport, the preview heading is above 390px; the earlier visual audit reported roughly 470px before preview. On phones, viewing the preview no longer requires scrolling through the entire settings form.

## Verification

All runs used isolated fixtures on port 5192 with at most two workers. Browser suites and TypeScript were serialized.

- Chromium: **45 passed**, 30.1 seconds.
- WebKit: **45 passed**, 27.3 seconds.
- Final spacing/capture follow-up: **8 Chromium** and **8 WebKit** studio journeys passed (7.4 and 7.5 seconds).
- Aggregate e2e TypeScript passed; `git diff --check` clean.

Suites: publishing-studio, publication-settings, publication-navigation, presentation, publication, plus existing settings-presentation cases selected by the filename filter. New 390/720px tests retain an explicit marker on the iframe across settings/preview switches, assert unchanged preview-read count, preserve a local title, verify saved-versus-unsaved labeling and keyboard focus after close. Existing password, content exclusions, failed writes, clipboard failure, private preview, template typography and reader navigation checks remain green.

Tests were adapted to the deliberate new interaction: expand Site address & membership before Copy, and select Preview view before opening an inline phone preview. An initial new assertion matched both article heading and table-of-contents link; it now targets the heading. These were fixture selector/workflow corrections, not concealed product failures. The final desktop capture waits for the actual article to load.

## Reviewed fictional captures

- [Compact desktop studio, 1280px Chromium](verification/frontend-20261002/publishing-compact-desktop-chromium.png)
- [390px light preview](verification/frontend-20261002/publishing-compact-390-chromium.png)
- [320px dark preview, WebKit](verification/frontend-20261002/publishing-compact-320-webkit.png)

The phone captures are full-page images. Layout checks include 1440/390/320px and 720px reflow. This evidence verifies fixture presentation and existing request behavior; production publication, compatible navigation projection and installed native preview remain integration/release checks.
