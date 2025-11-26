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

  // Generate wobbly path for hand-drawn effect
  const createWobblyPath = (startX: number, startY: number, endX: number, endY: number, wobble: number = 3): string => {
    const midX = (startX + endX) / 2
    const midY = (startY + endY) / 2
    const distance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2)
    const segments = Math.max(3, Math.floor(distance / 20))
    
    let path = `M ${startX} ${startY}`
    
    for (let i = 1; i <= segments; i++) {
      const t = i / segments
      const x = startX + (endX - startX) * t
      const y = startY + (endY - startY) * t
      
      // Add wobble perpendicular to the line
      const angle = Math.atan2(endY - startY, endX - startX) + Math.PI / 2
      const wobbleAmount = wobble * (Math.random() - 0.5) * (1 - Math.abs(t - 0.5) * 2)
      const wobbleX = x + Math.cos(angle) * wobbleAmount
      const wobbleY = y + Math.sin(angle) * wobbleAmount
      
      path += ` L ${wobbleX} ${wobbleY}`
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

        // Draw wobbly box (card outline) - make it more hand-drawn
        const boxPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const boxRadius = 16
        // Add slight wobble to corners for hand-drawn effect
        const wobbleAmount = 2
        const boxPathData = `
          M ${pos.x + boxRadius + (Math.random() - 0.5) * wobbleAmount} ${pos.y + (Math.random() - 0.5) * wobbleAmount}
          L ${pos.x + pos.width - boxRadius + (Math.random() - 0.5) * wobbleAmount} ${pos.y + (Math.random() - 0.5) * wobbleAmount}
          Q ${pos.x + pos.width + (Math.random() - 0.5) * wobbleAmount} ${pos.y + (Math.random() - 0.5) * wobbleAmount} ${pos.x + pos.width + (Math.random() - 0.5) * wobbleAmount} ${pos.y + boxRadius + (Math.random() - 0.5) * wobbleAmount}
          L ${pos.x + pos.width + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height - boxRadius + (Math.random() - 0.5) * wobbleAmount}
          Q ${pos.x + pos.width + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height + (Math.random() - 0.5) * wobbleAmount} ${pos.x + pos.width - boxRadius + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height + (Math.random() - 0.5) * wobbleAmount}
          L ${pos.x + boxRadius + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height + (Math.random() - 0.5) * wobbleAmount}
          Q ${pos.x + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height + (Math.random() - 0.5) * wobbleAmount} ${pos.x + (Math.random() - 0.5) * wobbleAmount} ${pos.y + pos.height - boxRadius + (Math.random() - 0.5) * wobbleAmount}
          L ${pos.x + (Math.random() - 0.5) * wobbleAmount} ${pos.y + boxRadius + (Math.random() - 0.5) * wobbleAmount}
          Q ${pos.x + (Math.random() - 0.5) * wobbleAmount} ${pos.y + (Math.random() - 0.5) * wobbleAmount} ${pos.x + boxRadius + (Math.random() - 0.5) * wobbleAmount} ${pos.y + (Math.random() - 0.5) * wobbleAmount}
          Z
        `
        boxPath.setAttribute('d', boxPathData.trim())
        boxPath.setAttribute('fill', 'none')
        boxPath.setAttribute('stroke', '#000000')
        boxPath.setAttribute('stroke-width', '2.5')
        boxPath.setAttribute('stroke-linecap', 'round')
        boxPath.setAttribute('stroke-linejoin', 'round')
        boxPath.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(boxPath)

        // Draw icon circle
        const iconSize = Math.min(pos.width, pos.height) * 0.15
        const iconX = pos.x + pos.width * 0.1
        const iconY = pos.y + pos.height * 0.15
        const iconRadius = iconSize / 2

        const iconCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        iconCircle.setAttribute('cx', (iconX + iconRadius).toString())
        iconCircle.setAttribute('cy', (iconY + iconRadius).toString())
        iconCircle.setAttribute('r', iconRadius.toString())
        iconCircle.setAttribute('fill', '#000000')
        iconCircle.setAttribute('stroke', 'none')
        iconCircle.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(iconCircle)

        // Draw step number (as text with sketchy style)
        const numberText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        numberText.setAttribute('x', (pos.x + pos.width * 0.9).toString())
        numberText.setAttribute('y', (pos.y + pos.height * 0.15).toString())
        numberText.setAttribute('font-size', (pos.width * 0.15).toString())
        numberText.setAttribute('font-weight', 'bold')
        numberText.setAttribute('fill', '#C0C0C0')
        numberText.setAttribute('text-anchor', 'end')
        numberText.setAttribute('dominant-baseline', 'hanging')
        numberText.textContent = step.number
        numberText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(numberText)

        // Draw title (as text)
        const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        titleText.setAttribute('x', (pos.x + pos.width * 0.1).toString())
        titleText.setAttribute('y', (pos.y + pos.height * 0.4).toString())
        titleText.setAttribute('font-size', Math.min(pos.width * 0.06, 24).toString())
        titleText.setAttribute('font-weight', 'bold')
        titleText.setAttribute('fill', '#000000')
        titleText.textContent = step.title
        titleText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(titleText)

        // Draw description (simplified - first line only for sketchy effect)
        const descText = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        const descWords = step.description.split(' ').slice(0, 8).join(' ') + '...'
        descText.setAttribute('x', (pos.x + pos.width * 0.1).toString())
        descText.setAttribute('y', (pos.y + pos.height * 0.55).toString())
        descText.setAttribute('font-size', Math.min(pos.width * 0.035, 16).toString())
        descText.setAttribute('fill', '#666666')
        descText.textContent = descWords
        descText.style.filter = 'url(#sketchy)'
        stepGroup.appendChild(descText)

        // Animate drawing the box
        const boxLength = boxPath.getTotalLength()
        boxPath.style.strokeDasharray = `${boxLength}`
        boxPath.style.strokeDashoffset = `${boxLength}`

        tl.to(boxPath, {
          strokeDashoffset: 0,
          duration: 0.8,
          ease: 'none',
        }, index * 1.2)

        // Animate icon circle appearing
        tl.to(iconCircle, {
          scale: 1,
          opacity: 1,
          duration: 0.5,
          ease: 'back.out(1.7)',
        }, index * 1.2 + 0.8)

        // Animate text appearing (with slight delay for sketchy effect)
        tl.to([numberText, titleText, descText], {
          opacity: 1,
          duration: 0.6,
          ease: 'power2.out',
        }, index * 1.2 + 1.0)

        // Draw connecting arrow to next step (if not last)
        if (index < steps.length - 1) {
          const nextPos = stepPositions[index + 1]
          const startX = pos.x + pos.width
          const startY = pos.y + pos.height / 2
          const endX = nextPos.x
          const endY = nextPos.y + nextPos.height / 2

          // Create wobbly arrow path
          const arrowPath = createWobblyPath(startX, startY, endX, endY, 4)
          const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          arrow.setAttribute('d', arrowPath)
          arrow.setAttribute('fill', 'none')
          arrow.setAttribute('stroke', '#EAB308') // Gold
          arrow.setAttribute('stroke-width', '3')
          arrow.setAttribute('stroke-linecap', 'round')
          arrow.setAttribute('stroke-linejoin', 'round')
          arrow.style.filter = 'url(#sketchy)'
          stepGroup.appendChild(arrow)

          // Draw arrowhead
          const arrowhead = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          const arrowAngle = Math.atan2(endY - startY, endX - startX)
          const arrowheadSize = 12
          const arrowheadPath = `
            M ${endX} ${endY}
            L ${endX - arrowheadSize * Math.cos(arrowAngle - Math.PI / 6)} ${endY - arrowheadSize * Math.sin(arrowAngle - Math.PI / 6)}
            L ${endX - arrowheadSize * Math.cos(arrowAngle + Math.PI / 6)} ${endY - arrowheadSize * Math.sin(arrowAngle + Math.PI / 6)}
            Z
          `
          arrowhead.setAttribute('d', arrowheadPath.trim())
          arrowhead.setAttribute('fill', '#EAB308')
          arrowhead.setAttribute('stroke', '#EAB308')
          arrowhead.setAttribute('stroke-width', '2')
          arrowhead.style.filter = 'url(#sketchy)'
          stepGroup.appendChild(arrowhead)

          // Animate arrow drawing
          const arrowLength = arrow.getTotalLength()
          arrow.style.strokeDasharray = `${arrowLength}`
          arrow.style.strokeDashoffset = `${arrowLength}`

          tl.to(arrow, {
            strokeDashoffset: 0,
            duration: 0.6,
            ease: 'none',
          }, index * 1.2 + 1.5)

          // Animate arrowhead appearing
          tl.to(arrowhead, {
            opacity: 1,
            scale: 1,
            duration: 0.3,
            ease: 'back.out(1.5)',
          }, index * 1.2 + 2.0)
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
            minHeight: '600px', 
            height: '70vh',
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
