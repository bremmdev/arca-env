import PublicLabel from './public-label'

export const dynamic = 'force-dynamic'

// A server component. React replays its console calls in the browser (the "Server" badge),
// and Next copies them into .next/dev/logs/next-development.log: both must get the masked value.
export default function Page() {
  console.log('page sees DATABASE_URL =', process.env.DATABASE_URL)
  const db = process.env.DATABASE_URL ?? ''
  const stripe = process.env.STRIPE_SECRET_KEY ?? ''
  return (
    <main>
      <p id="profile">{process.env.ARCA_PROFILE ?? 'none'}</p>
      {/* The host isn't secret: it shows which profile's value arrived. */}
      <p id="dbhost">{db ? new URL(db).hostname : 'none'}</p>
      <p id="injected">STRIPE_SECRET_KEY has {stripe.length} characters</p>
      <p id="title">{process.env.APP_TITLE ?? 'none'}</p>
      <PublicLabel />
    </main>
  )
}
