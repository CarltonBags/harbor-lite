/**
 * Wraps content into page containers to prevent visual breaks from cutting through text
 */

export function wrapContentInPages(contentElement: HTMLElement) {
  if (!contentElement) {
    console.error('[WrapPages] contentElement is null')
    return
  }

  console.log('[WrapPages] Starting page wrapping')
  console.log('[WrapPages] Content element:', contentElement.className, contentElement.id)
  
  // Remove existing page containers but preserve their content
  const existingContainers = contentElement.querySelectorAll('.thesis-page-container')
  console.log(`[WrapPages] Found ${existingContainers.length} existing page containers to unwrap`)
  
  existingContainers.forEach(container => {
    // Move children back to parent before the container
    while (container.firstChild) {
      contentElement.insertBefore(container.firstChild, container)
    }
    container.remove()
  })

  // A4 page dimensions: 247mm usable height
  const pageHeightMm = 247
  const pageHeightPx = pageHeightMm * 3.7795 // Convert mm to px (96 DPI)

  // Get all direct children (ReactMarkdown renders content here)
  // Filter out page number markers
  const children = Array.from(contentElement.children).filter(
    child => !child.classList.contains('page-number-marker')
  )
  
  if (children.length === 0) {
    console.log('[WrapPages] No children to wrap')
    return
  }

  console.log(`[WrapPages] Found ${children.length} children to wrap`)

  let currentPageContainer: HTMLElement | null = null
  let currentPageHeight = 0

  children.forEach((child, index) => {
    // Skip page number markers and existing page containers
    if (child.classList.contains('page-number-marker') || 
        child.classList.contains('thesis-page-container')) {
      return
    }

    // Don't wrap TOC heading separately - it should stay with TOC content
    // The TOC heading and list should be together on the same page

    // Get element height (use a minimum to prevent issues)
    const childHeight = Math.max((child as HTMLElement).offsetHeight || 50, 50)
    
    // Check if this is a heading - we don't want to break pages right after headings
    const isHeading = child.tagName === 'H1' || child.tagName === 'H2' || child.tagName === 'H3'
    const nextChild = children[index + 1]
    const nextChildHeight = nextChild ? Math.max((nextChild as HTMLElement).offsetHeight || 50, 50) : 0
    
    // Don't break page if:
    // 1. Current element is a heading and there's content after it
    // 2. Adding this element + next element would fit on current page
    const wouldFitWithNext = currentPageHeight + childHeight + nextChildHeight <= pageHeightPx
    const shouldNotBreak = isHeading && nextChild && wouldFitWithNext
    
    // Check if we need a new page
    if (!currentPageContainer || (currentPageHeight + childHeight > pageHeightPx && !shouldNotBreak)) {
      // Create new page container
      currentPageContainer = document.createElement('div')
      currentPageContainer.className = 'thesis-page-container'
      currentPageContainer.style.cssText = `
        position: relative;
        min-height: ${pageHeightMm}mm;
        margin-bottom: 2mm;
        background: #ffffff;
        z-index: 2;
        page-break-after: always;
      `
      contentElement.appendChild(currentPageContainer)
      currentPageHeight = 0
      console.log(`[WrapPages] Created new page container ${index}`)
    }

    // Move child to current page container
    currentPageContainer.appendChild(child)
    currentPageHeight += childHeight
    
    console.log(`[WrapPages] Added child ${index} (${child.tagName}) to page, height: ${childHeight}px, total: ${currentPageHeight}px`)
  })

  console.log(`[WrapPages] Finished wrapping ${children.length} elements into pages`)
}
