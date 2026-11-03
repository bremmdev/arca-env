export const dynamic = 'force-dynamic'

// A server component. React replays its console calls in the browser (the "Server" badge),
// and Next copies them into .next/dev/logs/next-development.log: both must get the masked value.
export default function Page() {
  console.log('page sees DATABASE_URL =', process.env.DATABASE_URL)
  const stripe = process.env.STRIPE_SECRET_KEY ?? ''
  return <p id="injected">STRIPE_SECRET_KEY has {stripe.length} characters</p>
}
