/**
 * Adds page numbers to the thesis document by inserting page number elements
 * at calculated positions based on content height
 */

export function addPageNumbers(contentElement: HTMLElement) {
  console.log('=== addPageNumbers called ===')
  console.log('contentElement:', contentElement)
  console.log('contentElement.className:', contentElement?.className)
  console.log('contentElement.id:', contentElement?.id)
  
  if (!contentElement) {
    console.error('addPageNumbers: contentElement is null')
    return
  }

  // Remove existing page markers from document container (not content element)
  const documentContainer = contentElement.closest('.thesis-document') as HTMLElement
  if (documentContainer) {
    const existingMarkers = documentContainer.querySelectorAll('.page-number-marker')
    console.log('Removing', existingMarkers.length, 'existing markers from document container')
    existingMarkers.forEach(marker => {
      if (marker.parentNode) {
        marker.parentNode.removeChild(marker)
      }
    })
  }

  // A4 page dimensions: 247mm usable height (297mm - 25mm top - 25mm bottom)
  const pageHeightMm = 247
  const pageHeightPx = pageHeightMm * 3.7795 // Convert mm to px (96 DPI)

  console.log('Page height:', pageHeightPx, 'px')

  // Wait a bit for content to be fully rendered, then try multiple times
  let attempts = 0
  const maxAttempts = 5
  
  const tryAddPageNumbers = () => {
    attempts++
    console.log(`[PageNumbers] Attempt ${attempts}/${maxAttempts} to add page numbers`)
    
    const container = contentElement
    const height = container.scrollHeight || container.offsetHeight
    
    console.log('[PageNumbers] Container height:', height, 'px')
    console.log('[PageNumbers] Container classes:', container.className)
    console.log('[PageNumbers] Container ID:', container.id)
    console.log('[PageNumbers] Container position:', getComputedStyle(container).position)
    console.log('[PageNumbers] Container children:', container.children.length)
    
    if (height > 100 || attempts >= maxAttempts) {
      // Content is rendered or we've tried enough times
      console.log('[PageNumbers] Content ready, calling addPageNumbersToElement')
      addPageNumbersToElement(contentElement, pageHeightPx)
    } else {
      // Content not ready yet, try again
      console.log('[PageNumbers] Content not ready yet, retrying in 500ms...')
      setTimeout(tryAddPageNumbers, 500)
    }
  }
  
  setTimeout(tryAddPageNumbers, 500)
}

function addPageNumbersToElement(element: HTMLElement, pageHeightPx: number) {
  console.log('=== addPageNumbersToElement called ===')
  console.log('element:', element)
  console.log('element.scrollHeight:', element.scrollHeight)
  console.log('element.offsetHeight:', element.offsetHeight)
  
  // Find the document container (thesis-document) - page numbers should be relative to it
  const documentContainer = element.closest('.thesis-document') as HTMLElement
  if (!documentContainer) {
    console.error('Could not find .thesis-document container!')
    return
  }
  
  // Use the content container (thesis-content div) for height calculation
  const container = element
  const containerHeight = container.scrollHeight || container.offsetHeight
  const totalPages = Math.max(1, Math.ceil(containerHeight / pageHeightPx))

  console.log('Adding page numbers:', { 
    containerHeight, 
    pageHeightPx, 
    totalPages,
    containerClass: container.className,
    containerTag: container.tagName,
    containerPosition: getComputedStyle(container).position,
    documentContainer: documentContainer.className,
    containerOverflow: getComputedStyle(container).overflow,
    documentOverflow: getComputedStyle(documentContainer).overflow,
    documentContainerHeight: documentContainer.scrollHeight || documentContainer.offsetHeight
  })
  
  // Get the offset of the content container within the document container
  const contentOffsetTop = container.offsetTop || 0
  console.log('Content offset from document:', contentOffsetTop)

  // Ensure document container has position relative and overflow visible
  if (getComputedStyle(documentContainer).position === 'static') {
    documentContainer.style.position = 'relative'
    console.log('Set document container position to relative')
  }
  if (getComputedStyle(documentContainer).overflow !== 'visible') {
    documentContainer.style.overflow = 'visible'
    console.log('Set document container overflow to visible')
  }

  // Ensure content container has position relative and overflow visible
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative'
    console.log('Set content container position to relative')
  }
  if (getComputedStyle(container).overflow !== 'visible') {
    container.style.overflow = 'visible'
    console.log('Set content container overflow to visible')
  }

  // Add page numbers at the bottom right of each logical page
  // Position them 15mm from the bottom and 30mm from the right
  const pageNumberBottomOffsetPx = 15 * 3.7795 // 15mm from bottom in pixels
  
  // Account for cover page - content starts after cover (247mm = one page height)
  const coverPageHeightPx = 247 * 3.7795

  for (let page = 1; page <= totalPages; page++) {
    const pageNumberEl = document.createElement('div')
    pageNumberEl.className = 'page-number-marker'
    pageNumberEl.setAttribute('data-page', page.toString())
    
    // Calculate position from top of document container
    // Account for cover page height (247mm) + content offset
    // Page numbers start from page 2 (page 1 is cover)
    const coverPageHeightPx = 247 * 3.7795
    const pageTop = coverPageHeightPx + contentOffsetTop + (page - 1) * pageHeightPx
    const pageNumberTop = pageTop + pageHeightPx - pageNumberBottomOffsetPx
    
    // Ensure page number is within visible bounds
    console.log(`Page ${page + 1}: top=${pageNumberTop}px (cover: ${coverPageHeightPx}px + offset: ${contentOffsetTop}px + page: ${(page - 1) * pageHeightPx}px)`)
    
    // Page numbers in bottom right corner, black color
    // Use absolute positioning relative to document container
    pageNumberEl.style.cssText = `
      position: absolute !important;
      top: ${pageNumberTop}px !important;
      right: 30mm !important;
      font-size: 10pt !important;
      color: #000000 !important;
      font-family: "Times New Roman", serif !important;
      pointer-events: none !important;
      z-index: 99999 !important;
      background: transparent !important;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      line-height: 1 !important;
      padding: 0 !important;
      margin: 0 !important;
      border: none !important;
      outline: none !important;
      font-weight: normal !important;
      text-align: right !important;
      width: auto !important;
    `
    pageNumberEl.textContent = (page + 1).toString() // Page 2, 3, 4... (page 1 is cover)
    
    // Force visibility
    pageNumberEl.setAttribute('data-visible', 'true')
    
    // Append to document container for correct positioning
    documentContainer.appendChild(pageNumberEl)
    console.log(`✓ Added page number ${page + 1} at top: ${pageNumberTop}px, right: 30mm`)
    
    // Verify it's visible
    setTimeout(() => {
      const rect = pageNumberEl.getBoundingClientRect()
      const styles = getComputedStyle(pageNumberEl)
      console.log(`Page ${page + 1} number visibility:`, {
        display: styles.display,
        visibility: styles.visibility,
        opacity: styles.opacity,
        zIndex: styles.zIndex,
        top: styles.top,
        right: styles.right,
        bounds: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      })
    }, 100)
    
    // Verify it's actually in the DOM and visible
    const rect = pageNumberEl.getBoundingClientRect()
    console.log(`  - Element bounds:`, { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    console.log(`  - Computed styles:`, {
      display: getComputedStyle(pageNumberEl).display,
      visibility: getComputedStyle(pageNumberEl).visibility,
      opacity: getComputedStyle(pageNumberEl).opacity,
      zIndex: getComputedStyle(pageNumberEl).zIndex
    })
  }
  
  // Verify page numbers were added
  const markers = container.querySelectorAll('.page-number-marker')
  console.log(`=== Finished adding ${totalPages} page numbers ===`)
  console.log(`=== Verification: Found ${markers.length} page number markers in DOM ===`)
  markers.forEach((marker, idx) => {
    console.log(`Marker ${idx + 1}:`, {
      text: marker.textContent,
      top: (marker as HTMLElement).style.top,
      visible: getComputedStyle(marker as HTMLElement).visibility,
      display: getComputedStyle(marker as HTMLElement).display,
      opacity: getComputedStyle(marker as HTMLElement).opacity
    })
  })
}

