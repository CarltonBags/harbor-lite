'use client'

interface PageNumberProps {
  pageNumber: number
  isCover?: boolean
}

export function PageNumber({ pageNumber, isCover = false }: PageNumberProps) {
  if (isCover) {
    return null // Cover page has no page number
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '15mm',
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: '10pt',
        color: '#666',
        fontFamily: '"Times New Roman", serif',
        width: '100%',
        textAlign: 'center',
      }}
    >
      {pageNumber}
    </div>
  )
}

