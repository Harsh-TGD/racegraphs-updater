# RaceGraphs v0.04.2 Free Updater

This public repository runs the checked F1 importer in GitHub Actions. Add repository secret RACEGRAPHS_R2 using START-HERE.html in the supplied ZIP, then Actions → Update RaceGraphs results → Run workflow. No terminal, npm install or build configuration is needed. Source processing is on GitHub; the Cloudflare Free Worker only serves prepared public JSON.

The included seed is F1DB v2026.19.0, CC BY 4.0, through Mexico City 2026 (round 19). Attribution: https://github.com/f1db/f1db/releases/tag/v2026.19.0 ; license in licenses/F1DB-LICENSE.txt. Keep source notes in published data.

The schedule is best effort every five minutes, checking less often between events. OpenF1/live timing is disabled. The 2026 seed needs a reviewed update for a new season. Public scheduled workflows may be disabled after sixty days without repository activity.

Keep credentials in GitHub Secrets. No keys, passwords or private configuration belong in this repository. Cloudflare credentials need Object Read & Write for the racegraphs-data bucket only.

Free use depends on GitHub public-repository standard-runner rules and Cloudflare R2/Workers allowances. No deployment or provider commercial clearance is implied by this source.
