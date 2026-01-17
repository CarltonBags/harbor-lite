// Test script for normalizeText
function normalizeText(text) {
    if (!text) return ''
    let normalized = text

    // Fix "SZ" that should be a space in compound words
    normalized = normalized.replace(/([a-zäöü])SZ([A-ZÄÖÜ])/g, '$1 Z$2')

    // Fix incorrect umlauts in English words
    normalized = normalized.replace(/\bÄre\b/gi, 'Are')
    normalized = normalized.replace(/\bÄnd\b/gi, 'And')
    normalized = normalized.replace(/\bÄny\b/gi, 'Any')
    normalized = normalized.replace(/\bÄll\b/gi, 'All')
    normalized = normalized.replace(/\bÄre\s+You\b/gi, 'Are You')

    // Fix standalone "Ä" at start of English words
    normalized = normalized.replace(/\bÄ([a-z]{2,})\b/g, (match, rest) => {
        const englishPatterns = ['re', 'nd', 'ny', 'll', 'nd', 're', 'ct', 'ble', 'bout', 'fter', 'gain', 'lso', 'mong', 'nother', 'lready', 'lways', 'lthough', 'mong', 'nswer', 'ppear', 'pply', 'pproach', 'rrange', 'rticle', 'spect', 'ssume', 'ttach', 'ttack', 'ttempt', 'ttend', 'ttitude', 'ttract', 'udience', 'uthor', 'vailable', 'verage', 'void', 'ward', 'ware', 'wake', 'ward', 'way']
        if (englishPatterns.some(pattern => rest.toLowerCase().startsWith(pattern))) {
            console.log('MATCH Ä->', match, 'becomes A' + rest)
            return 'A' + rest
        }
        return match
    })

    return normalized
}

// Test cases
const tests = [
    'Sphäre geprägt',
    'private Sphäre',
    'Äre', // should become Are
    'Sphäre', // should stay Sphäre
]

for (const test of tests) {
    console.log(`"${test}" => "${normalizeText(test)}"`)
}
