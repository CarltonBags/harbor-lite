'use client'

import { FileText, Twitter, Linkedin, Github, Mail } from 'lucide-react'

const footerLinks = {
  product: [
    { name: 'Funktionen', href: '#features' },
    { name: 'Preise', href: '#pricing' },
    { name: 'So funktioniert\'s', href: '#how-it-works' },
    { name: 'Vorlagen', href: '#' },
  ],
  resources: [
    { name: 'Dokumentation', href: '#' },
    { name: 'Anleitungen', href: '#' },
    { name: 'API-Referenz', href: '#' },
    { name: 'Support', href: '#' },
  ],
  company: [
    { name: 'Über uns', href: '#' },
    { name: 'Blog', href: '#' },
    { name: 'Karriere', href: '#' },
    { name: 'Kontakt', href: '#' },
  ],
  legal: [
    { name: 'Datenschutz', href: '#' },
    { name: 'Nutzungsbedingungen', href: '#' },
    { name: 'Cookie-Richtlinie', href: '#' },
    { name: 'DSGVO', href: '#' },
  ],
}

export function Footer() {
  return (
    <footer className="bg-gray-900 dark:bg-black text-gray-300">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-8 mb-8">
          {/* Brand */}
          <div className="lg:col-span-2">
            <div className="flex items-center space-x-2 mb-4">
              <FileText className="w-8 h-8 text-white" />
              <span className="text-2xl font-bold text-white">
                Uni<span className="text-yellow-600 dark:text-yellow-500">Lord</span>
              </span>
            </div>
            <p className="text-gray-400 mb-4">
              KI-gestützte Thesis-Schreibplattform für Studenten und Forscher weltweit.
            </p>
            <div className="flex space-x-4">
              <a
                href="#"
                className="w-10 h-10 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors"
                aria-label="Twitter"
              >
                <Twitter className="w-5 h-5" />
              </a>
              <a
                href="#"
                className="w-10 h-10 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors"
                aria-label="LinkedIn"
              >
                <Linkedin className="w-5 h-5" />
              </a>
              <a
                href="#"
                className="w-10 h-10 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors"
                aria-label="GitHub"
              >
                <Github className="w-5 h-5" />
              </a>
              <a
                href="#"
                className="w-10 h-10 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors"
                aria-label="Email"
              >
                <Mail className="w-5 h-5" />
              </a>
            </div>
          </div>
          
          {/* Product */}
          <div>
            <h3 className="text-white font-semibold mb-4">Produkt</h3>
            <ul className="space-y-2">
              {footerLinks.product.map((link) => (
                <li key={link.name}>
                  <a
                    href={link.href}
                    className="text-gray-400 hover:text-white transition-colors"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          
          {/* Resources */}
          <div>
            <h3 className="text-white font-semibold mb-4">Ressourcen</h3>
            <ul className="space-y-2">
              {footerLinks.resources.map((link) => (
                <li key={link.name}>
                  <a
                    href={link.href}
                    className="text-gray-400 hover:text-white transition-colors"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          
          {/* Company */}
          <div>
            <h3 className="text-white font-semibold mb-4">Unternehmen</h3>
            <ul className="space-y-2">
              {footerLinks.company.map((link) => (
                <li key={link.name}>
                  <a
                    href={link.href}
                    className="text-gray-400 hover:text-white transition-colors"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          
          {/* Legal */}
          <div>
            <h3 className="text-white font-semibold mb-4">Rechtliches</h3>
            <ul className="space-y-2">
              {footerLinks.legal.map((link) => (
                <li key={link.name}>
                  <a
                    href={link.href}
                    className="text-gray-400 hover:text-white transition-colors"
                  >
                    {link.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        
        <div className="border-t border-gray-800 pt-8 mt-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p className="text-gray-400 text-sm">
              © {new Date().getFullYear()} UniLord. Alle Rechte vorbehalten.
            </p>
            <p className="text-gray-400 text-sm mt-4 md:mt-0">
              Mit ❤️ gemacht für Forscher weltweit
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}

