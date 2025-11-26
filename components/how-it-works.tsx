'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Sparkles, Download, CheckCircle } from 'lucide-react'
import { gsap } from 'gsap'

const steps = [
  {
    number: '01',
    title: 'Beschreibe Deine Forschung',
    description: 'Erzähle uns von Deinem Thesis-Thema, Deiner Forschungsfrage und Methodik. Unsere KI versteht akademische Anforderungen.',
    icon: FileText,
  },
  {
    number: '02',
    title: 'KI generiert Struktur',
    description: 'Unsere moderne KI erstellt eine umfassende Thesis-Struktur mit passenden Abschnitten, Zitaten und Formatierung.',
    icon: Sparkles,
  },
  {
    number: '03',
    title: 'Verfeinern & Anpassen',
    description: 'Überprüfe und verfeinere den generierten Inhalt. Nimm Änderungen vor, füge Deine Forschungsergebnisse hinzu und passe nach Bedarf an.',
    icon: CheckCircle,
  },
  {
    number: '04',
    title: 'Exportieren & Einreichen',
    description: 'Exportiere Deine Thesis als professionell formatiertes PDF oder LaTeX-Dokument, bereit zur Einreichung.',
    icon: Download,
  },
]

export function HowItWorks() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [isAnimating, setIsAnimating] = useState(false)
  const [hasAnimated, setHasAnimated] = useState(false)
  const timelineRef = useRef<gsap.core.Timeline | null>(null)

  // Generate wobbly curved path for playful hand-drawn effect
  const createWobblyPath = (startX: number, startY: number, endX: number, endY: number, wobble: number = 3): string => {
    const distance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2)

    // Create a curved path using quadratic bezier curves for more playfulness
    const angle = Math.atan2(endY - startY, endX - startX)
    const perpAngle = angle + Math.PI / 2

    // Control point offset - creates the curve
    const curveOffset = distance * 0.3 * (Math.random() > 0.5 ? 1 : -1)
    const midX = (startX + endX) / 2 + Math.cos(perpAngle) * curveOffset
    const midY = (startY + endY) / 2 + Math.sin(perpAngle) * curveOffset

    // Add wobble to the curve for hand-drawn effect
    const segments = Math.max(5, Math.floor(distance / 20))
    let path = `M ${startX} ${startY}`

    for (let i = 1; i <= segments; i++) {
      const t = i / segments
      // Quadratic bezier formula
      const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * midX + t * t * endX
      const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * midY + t * t * endY

      // Add slight wobble
      const wobbleAmount = wobble * (Math.random() - 0.5)
      const wobbleX = x + Math.cos(perpAngle) * wobbleAmount
      const wobbleY = y + Math.sin(perpAngle) * wobbleAmount

      if (i === 1) {
        path += ` Q ${wobbleX} ${wobbleY}`
      } else {
        path += ` ${wobbleX} ${wobbleY}`
      }
    }

    return path
  }

  // Create organic blob shape instead of rigid box
  const createOrganicBlob = (x: number, y: number, width: number, height: number): string => {
    const centerX = x + width / 2
    const centerY = y + height / 2
    const radiusX = width / 2
    const radiusY = height / 2

    // Create wobbly ellipse with multiple control points
    const points = 16
    let path = ''

    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2
      const wobble = 3 + Math.random() * 4
      const rX = radiusX + (Math.random() - 0.5) * wobble
      const rY = radiusY + (Math.random() - 0.5) * wobble
      const px = centerX + Math.cos(angle) * rX
      const py = centerY + Math.sin(angle) * rY

      if (i === 0) {
        path += `M ${px} ${py}`
      } else {
        path += ` L ${px} ${py}`
      }
    }

    path += ' Z'
    return path
  }

  // Convert text to path for writing animation
  const createTextPath = (text: string, x: number, y: number, fontSize: number, fontFamily: string = 'Arial'): string => {
    // For simplicity, we'll create a path that represents the text outline
    // In a real implementation, you'd use a library like opentype.js or canvas text-to-path
    // For now, we'll create a wobbly underline path that animates
    const textWidth = text.length * fontSize * 0.6
    const segments = Math.max(8, Math.floor(textWidth / 10))
    let path = `M ${x} ${y + fontSize * 0.3}`

    for (let i = 1; i <= segments; i++) {
      const t = i / segments
      const px = x + textWidth * t
      const py = y + fontSize * 0.3 + (Math.random() - 0.5) * 2
      path += ` L ${px} ${py}`
    }

    return path
  }

  useEffect(() => {
    const container = containerRef.current
    const svg = svgRef.current
    if (!container || !svg) return

    const startAnimation = () => {
      if (hasAnimated) return
      setHasAnimated(true)
      setIsAnimating(true)

      // Clear any existing timeline
      if (timelineRef.current) {
        timelineRef.current.kill()
      }

      const rect = container.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      const isMobile = width < 768
      const isTablet = width < 1024

      // Set SVG size
      svg.setAttribute('width', width.toString())
      svg.setAttribute('height', height.toString())
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

      // Clear previous content
      svg.innerHTML = ''

      // Calculate step positions
      let stepPositions: Array<{ x: number; y: number; width: number; height: number }> = []

      if (isMobile) {
        const stepHeight = height / steps.length
        steps.forEach((_, index) => {
          stepPositions.push({
            x: width * 0.1,
            y: index * stepHeight + stepHeight * 0.1,
            width: width * 0.8,
            height: stepHeight * 0.8,
          })
        })
      } else if (isTablet) {
        const stepWidth = width / 2
        const stepHeight = height / 2
        steps.forEach((_, index) => {
          const col = index % 2
          const row = Math.floor(index / 2)
          stepPositions.push({
            x: col * stepWidth + stepWidth * 0.1,
            y: row * stepHeight + stepHeight * 0.1,
            width: stepWidth * 0.8,
            height: stepHeight * 0.8,
          })
        })
      } else {
        const stepWidth = width / steps.length
        steps.forEach((_, index) => {
          stepPositions.push({
            x: index * stepWidth + stepWidth * 0.1,
            y: height * 0.2,
            width: stepWidth * 0.8,
            height: height * 0.6,
          })
        })
      }

      // Create timeline
      const tl = gsap.timeline({
        onComplete: () => setIsAnimating(false),
      })

      // Create SVG group for all elements
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      svg.appendChild(g)

      // Animate each step
      stepPositions.forEach((pos, index) => {
        const step = steps[index]
        const stepGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        stepGroup.setAttribute('class', `step-${index}`)
        g.appendChild(stepGroup)

        // Draw organic blob shape instead of rigid box
        const blobPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const blobData = createOrganicBlob(pos.x, pos.y, pos.width, pos.height)
        blobPath.setAttribute('d', blobData)
        blobPath.setAttribute('fill', 'none')
        blobPath.setAttribute('stroke', '#000000')
        blobPath.setAttribute('stroke-width', '2.5')
        blobPath.setAttribute('stroke-linecap', 'round')
        blobPath.setAttribute('stroke-linejoin', 'round')
        blobPath.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(blobPath)

        // Draw organic icon circle (wobbly)
        const iconSize = Math.min(pos.width, pos.height) * 0.15
        const iconX = pos.x + pos.width * 0.1
        const iconY = pos.y + pos.height * 0.15
        const iconRadius = iconSize / 2
        const iconCenterX = iconX + iconRadius
        const iconCenterY = iconY + iconRadius

        // Create wobbly circle path
        const iconCirclePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const circlePoints = 20
        let circlePath = ''
        for (let i = 0; i <= circlePoints; i++) {
          const angle = (i / circlePoints) * Math.PI * 2
          const wobble = 2 + Math.random() * 3
          const r = iconRadius + (Math.random() - 0.5) * wobble
          const px = iconCenterX + Math.cos(angle) * r
          const py = iconCenterY + Math.sin(angle) * r
          if (i === 0) {
            circlePath += `M ${px} ${py}`
          } else {
            circlePath += ` L ${px} ${py}`
          }
        }
        circlePath += ' Z'
        iconCirclePath.setAttribute('d', circlePath)
        // Start with no fill for animation
        iconCirclePath.setAttribute('fill', 'none')
        iconCirclePath.setAttribute('stroke', '#000000')
        iconCirclePath.setAttribute('stroke-width', '2.5')
        iconCirclePath.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(iconCirclePath)

        // Draw step number (as text that appears to be written)
        const numberText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        const numberFontSize = pos.width * 0.15
        numberText.setAttribute('x', (pos.x + pos.width * 0.9).toString())
        numberText.setAttribute('y', (pos.y + pos.height * 0.15).toString())
        numberText.setAttribute('font-size', numberFontSize.toString())
        numberText.setAttribute('font-weight', 'bold')
        numberText.setAttribute('fill', '#C0C0C0')
        numberText.setAttribute('text-anchor', 'end')
        numberText.setAttribute('dominant-baseline', 'hanging')
        numberText.setAttribute('font-family', 'Arial, sans-serif')
        numberText.textContent = step.number
        numberText.style.opacity = '0'
        numberText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(numberText)

        // Create underline path for number (writing effect)
        const numberUnderline = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const numberX = pos.x + pos.width * 0.9
        const numberY = pos.y + pos.height * 0.15 + numberFontSize * 0.3
        const numberWidth = numberFontSize * step.number.length * 0.6
        const numberPath = createTextPath(step.number, numberX - numberWidth, numberY, numberFontSize)
        numberUnderline.setAttribute('d', numberPath)
        numberUnderline.setAttribute('fill', 'none')
        numberUnderline.setAttribute('stroke', '#C0C0C0')
        numberUnderline.setAttribute('stroke-width', '2')
        numberUnderline.setAttribute('stroke-linecap', 'round')
        numberUnderline.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(numberUnderline)

        // Draw title (as text that appears to be written)
        const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        const titleFontSize = Math.min(pos.width * 0.06, 24)
        titleText.setAttribute('x', (pos.x + pos.width * 0.1).toString())
        titleText.setAttribute('y', (pos.y + pos.height * 0.4).toString())
        titleText.setAttribute('font-size', titleFontSize.toString())
        titleText.setAttribute('font-weight', 'bold')
        titleText.setAttribute('fill', '#000000')
        titleText.setAttribute('font-family', 'Arial, sans-serif')
        titleText.textContent = step.title
        titleText.style.opacity = '0'
        titleText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(titleText)

        // Create underline path for title (writing effect)
        const titleUnderline = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const titleX = pos.x + pos.width * 0.1
        const titleY = pos.y + pos.height * 0.4 + titleFontSize * 0.3
        const titlePath = createTextPath(step.title, titleX, titleY, titleFontSize)
        titleUnderline.setAttribute('d', titlePath)
        titleUnderline.setAttribute('fill', 'none')
        titleUnderline.setAttribute('stroke', '#000000')
        titleUnderline.setAttribute('stroke-width', '2')
        titleUnderline.setAttribute('stroke-linecap', 'round')
        titleUnderline.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(titleUnderline)

        // Draw description (as text that appears to be written)
        const descText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        const descWords = step.description.split(' ').slice(0, 10).join(' ') + '...'
        const descFontSize = Math.min(pos.width * 0.035, 16)
        descText.setAttribute('x', (pos.x + pos.width * 0.1).toString())
        descText.setAttribute('y', (pos.y + pos.height * 0.55).toString())
        descText.setAttribute('font-size', descFontSize.toString())
        descText.setAttribute('fill', '#666666')
        descText.setAttribute('font-family', 'Arial, sans-serif')
        descText.textContent = descWords
        descText.style.opacity = '0'
        descText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(descText)

        // Create underline path for description (writing effect)
        const descUnderline = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const descX = pos.x + pos.width * 0.1
        const descY = pos.y + pos.height * 0.55 + descFontSize * 0.3
        const descPath = createTextPath(descWords, descX, descY, descFontSize)
        descUnderline.setAttribute('d', descPath)
        descUnderline.setAttribute('fill', 'none')
        descUnderline.setAttribute('stroke', '#666666')
        descUnderline.setAttribute('stroke-width', '1.5')
        descUnderline.setAttribute('stroke-linecap', 'round')
        descUnderline.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(descUnderline)

        // Animate drawing the blob
        const blobLength = blobPath.getTotalLength()
        blobPath.style.strokeDasharray = `${blobLength}`
        blobPath.style.strokeDashoffset = `${blobLength}`

        tl.to(blobPath, {
          strokeDashoffset: 0,
          duration: 1.0,
          ease: 'none',
        }, index * 1.5)

        // Animate icon circle being drawn
        const iconLength = iconCirclePath.getTotalLength()
        iconCirclePath.style.strokeDasharray = `${iconLength}`
        iconCirclePath.style.strokeDashoffset = `${iconLength}`

        tl.to(iconCirclePath, {
          strokeDashoffset: 0,
          duration: 0.8,
          ease: 'none',
        }, index * 1.5 + 1.0)

        // Fill icon circle after drawing
        tl.to(iconCirclePath, {
          attr: { fill: '#000000' },
          duration: 0.3,
        }, index * 1.5 + 1.8)

        // Animate text being "written" (underline draws first, then text appears)
        const numberUnderlineLength = numberUnderline.getTotalLength()
        numberUnderline.style.strokeDasharray = `${numberUnderlineLength}`
        numberUnderline.style.strokeDashoffset = `${numberUnderlineLength}`

        tl.to(numberUnderline, {
          strokeDashoffset: 0,
          duration: 0.4,
          ease: 'none',
        }, index * 1.5 + 2.0)

        tl.to(numberText, {
          opacity: 1,
          duration: 0.3,
        }, index * 1.5 + 2.4)

        // Animate title being written
        const titleUnderlineLength = titleUnderline.getTotalLength()
        titleUnderline.style.strokeDasharray = `${titleUnderlineLength}`
        titleUnderline.style.strokeDashoffset = `${titleUnderlineLength}`

        tl.to(titleUnderline, {
          strokeDashoffset: 0,
          duration: 0.6,
          ease: 'none',
        }, index * 1.5 + 2.7)

        tl.to(titleText, {
          opacity: 1,
          duration: 0.4,
        }, index * 1.5 + 3.3)

        // Animate description being written
        const descUnderlineLength = descUnderline.getTotalLength()
        descUnderline.style.strokeDasharray = `${descUnderlineLength}`
        descUnderline.style.strokeDashoffset = `${descUnderlineLength}`

        tl.to(descUnderline, {
          strokeDashoffset: 0,
          duration: 0.8,
          ease: 'none',
        }, index * 1.5 + 3.7)

        tl.to(descText, {
          opacity: 1,
          duration: 0.5,
        }, index * 1.5 + 4.5)

        // Draw connecting arrow to next step (if not last)
        if (index < steps.length - 1) {
          const nextPos = stepPositions[index + 1]
          const startX = pos.x + pos.width
          const startY = pos.y + pos.height / 2
          const endX = nextPos.x
          const endY = nextPos.y + nextPos.height / 2

          // Create playful curved arrow path
          const arrowPath = createWobblyPath(startX, startY, endX, endY, 5)
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          arrow.setAttribute('d', arrowPath)
          arrow.setAttribute('fill', 'none')
          arrow.setAttribute('stroke', '#EAB308') // Gold
          arrow.setAttribute('stroke-width', '4')
          arrow.setAttribute('stroke-linecap', 'round')
          arrow.setAttribute('stroke-linejoin', 'round')
          arrow.style.filter = 'url(#sketchy)'
          stepGroup.appendChild(arrow)

          // Draw arrowhead with more playful shape
          const arrowhead = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          const arrowAngle = Math.atan2(endY - startY, endX - startX)
          const arrowheadSize = 16
          const arrowheadPath = `
            M ${endX} ${endY}
            L ${endX - arrowheadSize * Math.cos(arrowAngle - Math.PI / 5)} ${endY - arrowheadSize * Math.sin(arrowAngle - Math.PI / 5)}
            L ${endX - arrowheadSize * 0.6 * Math.cos(arrowAngle)} ${endY - arrowheadSize * 0.6 * Math.sin(arrowAngle)}
            L ${endX - arrowheadSize * Math.cos(arrowAngle + Math.PI / 5)} ${endY - arrowheadSize * Math.sin(arrowAngle + Math.PI / 5)}
            Z
          `
          arrowhead.setAttribute('d', arrowheadPath.trim())
          arrowhead.setAttribute('fill', '#EAB308')
          arrowhead.setAttribute('stroke', '#EAB308')
          arrowhead.setAttribute('stroke-width', '2')
          arrowhead.style.filter = 'url(#sketchy)'
          stepGroup.appendChild(arrowhead)

          // Add playful decorative elements around the arrow
          // Sparkle 1
          const sparkle1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          const sparkle1X = startX + (endX - startX) * 0.3
          const sparkle1Y = startY + (endY - startY) * 0.3 - 20
          const sparkle1Path = `
            M ${sparkle1X} ${sparkle1Y - 8}
            L ${sparkle1X} ${sparkle1Y + 8}
            M ${sparkle1X - 8} ${sparkle1Y}
            L ${sparkle1X + 8} ${sparkle1Y}
            M ${sparkle1X - 6} ${sparkle1Y - 6}
            L ${sparkle1X + 6} ${sparkle1Y + 6}
            M ${sparkle1X - 6} ${sparkle1Y + 6}
            L ${sparkle1X + 6} ${sparkle1Y - 6}
          `
          sparkle1.setAttribute('d', sparkle1Path.trim())
          sparkle1.setAttribute('stroke', '#EAB308')
          sparkle1.setAttribute('stroke-width', '2')
          sparkle1.setAttribute('stroke-linecap', 'round')
          sparkle1.setAttribute('opacity', '0')
          stepGroup.appendChild(sparkle1)

          // Sparkle 2
          const sparkle2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          const sparkle2X = startX + (endX - startX) * 0.7
          const sparkle2Y = startY + (endY - startY) * 0.7 + 25
          const sparkle2Path = `
            M ${sparkle2X} ${sparkle2Y - 6}
            L ${sparkle2X} ${sparkle2Y + 6}
            M ${sparkle2X - 6} ${sparkle2Y}
            L ${sparkle2X + 6} ${sparkle2Y}
          `
          sparkle2.setAttribute('d', sparkle2Path.trim())
          sparkle2.setAttribute('stroke', '#EAB308')
          sparkle2.setAttribute('stroke-width', '2.5')
          sparkle2.setAttribute('stroke-linecap', 'round')
          sparkle2.setAttribute('opacity', '0')
          stepGroup.appendChild(sparkle2)

          // Add handwritten annotation
          const annotationText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          const annotationX = startX + (endX - startX) * 0.5
          const annotationY = startY + (endY - startY) * 0.5 - 30
          const annotations = ['Weiter!', 'Los!', 'Dann...', 'Und...']
          annotationText.setAttribute('x', annotationX.toString())
          annotationText.setAttribute('y', annotationY.toString())
          annotationText.setAttribute('font-size', '14')
          annotationText.setAttribute('font-family', 'Comic Sans MS, cursive')
          annotationText.setAttribute('fill', '#666666')
          annotationText.setAttribute('text-anchor', 'middle')
          annotationText.setAttribute('opacity', '0')
          annotationText.textContent = annotations[index % annotations.length]
          stepGroup.appendChild(annotationText)

          // Animate arrow drawing
          const arrowLength = arrow.getTotalLength()
          arrow.style.strokeDasharray = `${arrowLength}`
          arrow.style.strokeDashoffset = `${arrowLength}`

          tl.to(arrow, {
            strokeDashoffset: 0,
            duration: 1.2,
            ease: 'power1.inOut',
          }, index * 1.5 + 5.0)

          // Animate arrowhead appearing with bounce
          arrowhead.style.opacity = '0'
          tl.to(arrowhead, {
            opacity: 1,
            scale: 1,
            duration: 0.5,
            ease: 'back.out(2)',
          }, index * 1.5 + 6.2)

          // Animate sparkles appearing
          tl.to(sparkle1, {
            opacity: 0.8,
            duration: 0.3,
            ease: 'power2.out',
          }, index * 1.5 + 6.0)

          tl.to(sparkle1, {
            opacity: 0,
            duration: 0.3,
            ease: 'power2.in',
          }, index * 1.5 + 6.6)

          tl.to(sparkle2, {
            opacity: 0.7,
            duration: 0.3,
            ease: 'power2.out',
          }, index * 1.5 + 6.3)

          tl.to(sparkle2, {
            opacity: 0,
            duration: 0.3,
            ease: 'power2.in',
          }, index * 1.5 + 6.9)

          // Animate annotation text
          tl.to(annotationText, {
            opacity: 0.6,
            duration: 0.4,
            ease: 'power2.out',
          }, index * 1.5 + 5.8)
        }
      })

      // Add sketchy filter definition (only if not already exists)
      if (!svg.querySelector('#sketchy')) {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter')
        filter.setAttribute('id', 'sketchy')
        filter.setAttribute('x', '-50%')
        filter.setAttribute('y', '-50%')
        filter.setAttribute('width', '200%')
        filter.setAttribute('height', '200%')

        // Add turbulence for sketchy effect
        const turbulence = document.createElementNS('http://www.w3.org/2000/svg', 'feTurbulence')
        turbulence.setAttribute('baseFrequency', '0.04 0.04')
        turbulence.setAttribute('numOctaves', '3')
        turbulence.setAttribute('result', 'noise')
        filter.appendChild(turbulence)

        // Add displacement for wobbly effect
        const displacement = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap')
        displacement.setAttribute('in', 'SourceGraphic')
        displacement.setAttribute('in2', 'noise')
        displacement.setAttribute('scale', '2')
        displacement.setAttribute('xChannelSelector', 'R')
        displacement.setAttribute('yChannelSelector', 'G')
        filter.appendChild(displacement)

        defs.appendChild(filter)
        svg.insertBefore(defs, svg.firstChild)
      }

      timelineRef.current = tl
    }

    // Intersection Observer to start animation when in view
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !hasAnimated) {
          startAnimation()
        }
      },
      { threshold: 0.2 }
    )

    observer.observe(container)

    // Also try to start immediately if container is already visible
    if (container.getBoundingClientRect().top < window.innerHeight) {
      setTimeout(() => {
        if (!hasAnimated) {
          startAnimation()
        }
      }, 300)
    }

    return () => {
      observer.disconnect()
      if (timelineRef.current) {
        timelineRef.current.kill()
      }
    }
  }, [hasAnimated])

  return (
    <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8 bg-white dark:bg-gray-900">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-gray-900 dark:text-white">
            So funktioniert's
          </h2>
          <p className="text-xl text-gray-600 dark:text-gray-400">
            Von der Idee zur Einreichung in vier einfachen Schritten
          </p>
        </div>

        {/* SVG Container with notebook paper background */}
        <div
          ref={containerRef}
          className="relative w-full mx-auto"
          style={{
            minHeight: '1200px',
            height: '120vh',
            backgroundImage: `
              linear-gradient(to right, transparent 0%, transparent 48px, #E8E8E8 48px, #E8E8E8 50px, transparent 50px),
              linear-gradient(to bottom, transparent 0%, transparent 40px, #E8E8E8 40px, #E8E8E8 42px, transparent 42px)
            `,
            backgroundSize: '100% 40px',
            backgroundPosition: '0 0, 48px 0',
            backgroundColor: '#FEFEFE',
            border: '1px solid #E0E0E0',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
        >
          <svg
            ref={svgRef}
            className="absolute inset-0 w-full h-full"
            style={{
              mixBlendMode: 'multiply',
            }}
          />

          {/* Restart Animation Button */}
          <button
            onClick={() => {
              if (timelineRef.current) {
                timelineRef.current.kill()
              }
              const svg = svgRef.current
              if (svg) {
                svg.innerHTML = ''
              }
              setHasAnimated(false)
              setIsAnimating(false)
              // Force re-render to trigger animation
              setTimeout(() => {
                setHasAnimated(false)
              }, 50)
            }}
            className="absolute bottom-4 right-4 px-4 py-2 bg-yellow-600 dark:bg-yellow-500 text-black dark:text-white rounded-lg font-medium hover:bg-yellow-700 dark:hover:bg-yellow-400 transition-colors shadow-lg z-10"
            style={{ fontFamily: 'Comic Sans MS, cursive' }}
            aria-label="Animation neu starten"
          >
            ↻ Erneut zeichnen
          </button>
        </div>

        {/* Fallback: Static grid for accessibility and SEO */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mt-8 opacity-0 pointer-events-none absolute -z-10" aria-hidden="true">
          {steps.map((step, index) => {
            const Icon = step.icon
            return (
              <div key={index} className="relative">
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 h-full shadow-lg">
                  <div className="flex items-center justify-between mb-6">
                    <div className="w-16 h-16 rounded-full bg-black dark:bg-white flex items-center justify-center">
                      <Icon className="w-8 h-8 text-white dark:text-black" />
                    </div>
                    <span className="text-6xl font-bold text-gray-200 dark:text-gray-700">
                      {step.number}
                    </span>
                  </div>

                  <h3 className="text-xl font-bold mb-3 text-black dark:text-white">
                    {step.title}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400">
                    {step.description}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
