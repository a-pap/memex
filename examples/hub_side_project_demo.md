# Hub: SideProject — Local Experience Marketplace
<!-- fresh: 2026-04-06 -->

## Overview
Pre-launch SaaS — connects local experience providers (tours, workshops, tastings) with tourists. Think "Airbnb Experiences but for small-town providers who can't handle Airbnb's onboarding."

## Tech stack
- **Frontend:** Next.js 14, Tailwind, deployed on Vercel
- **Backend:** Supabase (Postgres, Auth, Storage)
- **Payments:** Stripe Connect (live) + SumUp (in-person, WIP)
- **Messaging:** WhatsApp Business API (blocked — Meta review)

## Status <!-- fresh: 2026-04-06 -->

### What works
- Provider onboarding flow (sign up → create listing → go live)
- Stripe Connect: split payments, provider payouts
- 3 pilot providers in Lisbon (2 active, 1 paused)
- Landing page with waitlist (47 signups)

### What's broken
- **Deploy pipeline** — Vercel preview deploys work, production fails (env var issue). Needs fix before launch.
- **SumUp integration** — spinner bug on payment confirmation. Low priority (Stripe works).
- **WhatsApp** — Meta Business Verification rejected. Re-submitted with LLC docs. ETA unknown.

### What's next
- Fix production deploy (P0 — blocks everything)
- Provider dashboard: earnings view, booking calendar
- Tourist-facing discovery page (search by city, category)
- SEO: structured data for listings

## Key metrics (as of Apr 6)
| Metric | Value | Target |
|--------|-------|--------|
| Providers onboarded | 3 | 10 by launch |
| Active listings | 5 | 20 by launch |
| Waitlist signups | 47 | 100 by launch |
| Bookings (test) | 12 | — |
| Revenue | €0 | €500/mo by month 3 |

## Key decisions (SETTLED)
| Date | Decision | Why |
|------|----------|-----|
| 2026-02-15 | Stripe Connect over custom payment flow | Compliance, speed to market |
| 2026-03-01 | SumUp for in-person parallel to Stripe | Some providers are cash/card-only at venue |
| 2026-03-20 | Supabase over custom backend | Solo dev, need speed. Can migrate later. |
| 2026-03-28 | Launch in Lisbon first, then expand | Partner's network there, good test market |

## Partner & collaborators
| Who | Role | Contact method |
|-----|------|---------------|
| Lukas | Co-founder, biz dev | Telegram, weekly sync Fri 15:00 |
| Freelancer (Ana) | Design | Figma, async |

## Budget
- **Monthly costs:** Vercel Pro €20, Supabase Pro €25, Domain €1, Stripe fees 2.9%+€0.30/tx
- **Runway:** Side project budget, no external funding. Target: self-sustaining by month 6.
