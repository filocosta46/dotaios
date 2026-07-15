import {useEffect, useState} from 'react'

export default function useScrollNav() {
  const [navState, setNavState] = useState('top')

  useEffect(() => {
    const header = document.querySelector('.site-header')
    const darkZone = document.querySelector('.bottom-cta')
    if (!header) return undefined

    let ticking = false

    function update() {
      ticking = false
      const y = window.scrollY
      const darkRect = darkZone?.getBoundingClientRect()
      const headerHeight = header.offsetHeight || 64

      if (darkRect && darkRect.top <= headerHeight && darkRect.bottom > 0) {
        setNavState('dark-zone')
        return
      }

      if (y > 24) {
        setNavState('scrolled')
        return
      }

      setNavState('top')
    }

    function onScroll() {
      if (!ticking) {
        ticking = true
        window.requestAnimationFrame(update)
      }
    }

    update()
    window.addEventListener('scroll', onScroll, {passive: true})
    window.addEventListener('resize', onScroll, {passive: true})

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  return navState
}
