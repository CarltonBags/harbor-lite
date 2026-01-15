import { createSupabaseServerClient } from '@/lib/supabase/client'
import { ClientPanel } from './client-panel'

export const dynamic = 'force-dynamic' // Ensure fresh data on every request

export default async function AdminHumanizerPage() {
    const supabase = createSupabaseServerClient()

    // Fetch lists without RLS filtering (Service Role)
    const { data: theses, error } = await supabase
        .from('theses')
        .select('id, topic, created_at, thesis_type, user_id')
        .order('created_at', { ascending: false })
        .limit(50)

    if (error) {
        return (
            <div className="p-8 text-red-500 bg-red-50 rounded-lg border border-red-200 m-8">
                <h2 className="text-lg font-bold mb-2">Error Fetching Data</h2>
                <p>{error.message}</p>
            </div>
        )
    }

    return (
        <div className="container mx-auto p-8 max-w-7xl">
            <header className="mb-8 border-b pb-6">
                <h1 className="text-3xl font-bold tracking-tight mb-2">Humanizer Testing Panel</h1>
                <p className="text-muted-foreground text-gray-500">
                    Select a thesis to generate structured JSON payloads for the external Humanizer API.
                </p>
            </header>

            <ClientPanel theses={theses || []} />
        </div>
    )
}
