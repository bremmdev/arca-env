'use client'
import { useEffect, useState } from 'react'

// Read in an effect, so the value comes from the browser bundle (inlined at compile time),
// not from the server render.
export default function PublicLabel() {
  const [label, setLabel] = useState('loading')
  useEffect(() => setLabel(process.env.NEXT_PUBLIC_APP_LABEL ?? 'none'), [])
  return <p id="public">{label}</p>
}
