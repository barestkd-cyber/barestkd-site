# Refreshing the public class schedule

The weekly schedule on **/schedule/events** is **static HTML**, generated from the
live `schedule_template` table. It does not fetch at page load, so it stays fast
and readable without JavaScript, but it does **not** update on its own.

**Whenever the class schedule changes in classplan, re-run the sync below.**

Note: the trial booking popup reads its class times **live** on every open, so it
is always current and needs no action. Program pages (`data-schedule-program`)
are live too. This sync is only for the static schedule page.

## The sync prompt

Paste this to Claude Code in this repo:

> Re-sync the static schedule on /schedule/events from the live schedule_template.
> Curl the deployed endpoint `GET /functions/v1/trial-booking?view=full`, regenerate
> the weekly schedule table (Monday through Saturday, no Sunday, each class showing
> its time and label, same markup and CSS classes as the current page), and replace
> the existing `<div class="schedule">` block in /schedule/events/index.html.
> Do not touch trial.js, the popup, or assets/js/schedule.js. Then show me the diff
> and commit.

## Doing it by hand

1. Pull the current class list:

```bash
curl -s "https://akdncbzxiwvihfcyijvm.supabase.co/functions/v1/trial-booking?view=full" -H "apikey: sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5" -H "Authorization: Bearer sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5"
```

2. It returns `{"classes":[{day,time_h,time_m,label,prog_css}, ...]}` where **`day`
   is 0 = Monday through 5 = Saturday** and `time_h` is a 24-hour clock.

3. Rewrite the `<div class="schedule">` block in
   [/schedule/events/index.html](schedule/events/index.html) to match. Each class is:

```html
<li class="schedule-class" data-p="Taekwondo">
  <span class="schedule-class__time">5:00 PM</span>
  <span class="schedule-class__name">Juniors</span>
  <span class="schedule-class__detail">Ages 13+</span>
</li>
```

   - `data-p` sets the name color and maps from `prog_css`:
     `prog-juniors` / `prog-teen` / `prog-forms` / `prog-leader` / `prog-sparring`
     -> `Taekwondo`; `prog-cubs` -> `Cubs`; `prog-ampd` -> `AMP'D`;
     `prog-kick` -> `Jiu Jitsu` if the label mentions jiu/bjj, otherwise `Kickboxing`.
   - Display names and the small detail line come from `CLASS_META` in
     [assets/js/schedule.js](assets/js/schedule.js). Keep the two in sync so the
     static page and the live program pages read the same (for example
     `Jiu-Jitsu (BJJ)` displays as **Jiu Jitsu**, `No-Gi BJJ / 13+`).
   - Skip any day with no classes. Never render Sunday.

## Where the data comes from

`view=full` is a read-only mode of the `trial-booking` Edge Function
([supabase/functions/trial-booking/index.ts](supabase/functions/trial-booking/index.ts)).
It returns every `schedule_template` row, cached about five minutes, and is
separate from the grouped payload the popup uses.
