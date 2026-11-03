import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'

const getStatus = createServerFn({ method: 'GET' }).handler(async () => {
  console.log('server function sees DATABASE_URL =', process.env.DATABASE_URL)
  const db = process.env.DATABASE_URL ?? ''
  return {
    profile: process.env.ARCA_PROFILE ?? 'none',
    // The host isn't secret: it shows which profile's value arrived.
    dbHost: db ? new URL(db).hostname : 'none',
    stripeLength: (process.env.STRIPE_SECRET_KEY ?? '').length,
    title: process.env.APP_TITLE ?? 'none',
  }
})

export const Route = createFileRoute('/')({
  loader: () => getStatus(),
  component: Home,
})

function Home() {
  const s = Route.useLoaderData()
  return (
    <main>
      <p id="profile">{s.profile}</p>
      <p id="dbhost">{s.dbHost}</p>
      <p id="injected">STRIPE_SECRET_KEY has {s.stripeLength} characters</p>
      <p id="title">{s.title}</p>
      <PublicLabel />
    </main>
  )
}

// Read in an effect, so the value comes from the browser bundle, not from the server render.
function PublicLabel() {
  const [label, setLabel] = useState('loading')
  useEffect(() => setLabel(import.meta.env.VITE_APP_LABEL ?? 'none'), [])
  return <p id="public">{label}</p>
}
