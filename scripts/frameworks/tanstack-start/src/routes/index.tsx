import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

const getStatus = createServerFn({ method: 'GET' }).handler(async () => {
  console.log('server function sees DATABASE_URL =', process.env.DATABASE_URL)
  return { stripeLength: (process.env.STRIPE_SECRET_KEY ?? '').length }
})

export const Route = createFileRoute('/')({
  loader: () => getStatus(),
  component: Home,
})

function Home() {
  const s = Route.useLoaderData()
  return <p id="injected">STRIPE_SECRET_KEY has {s.stripeLength} characters</p>
}
