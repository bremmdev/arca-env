// A database driver error that prints the connection string.
export function GET() {
  console.error(`Error: password authentication failed. Connection: ${process.env.DATABASE_URL}`)
  console.log('Using Stripe key', process.env.STRIPE_SECRET_KEY)
  return Response.json({ ok: true })
}
