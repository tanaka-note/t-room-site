package jp.tanaka.tcloud.data

import org.junit.Assert.assertTrue
import org.junit.Test

class SearchRankingTest {
    @Test
    fun `direct child is ranked before a deeper exact match`() {
        assertTrue(compareSearchResultValues(1, "Best of KAT-TUN", 2, "KAT-TUN", "kat-tun") < 0)
    }

    @Test
    fun `exact name is ranked before partial names at the same depth`() {
        assertTrue(compareSearchResultValues(1, "KAT-TUN", 1, "Best of KAT-TUN", "kat-tun") < 0)
    }

    @Test
    fun `unrelated decrypted candidates are ranked last`() {
        assertTrue(searchNameMatchRank("NEVER AGAIN.mp3", "never again") < searchNameMatchRank("Folder.jpg", "never again"))
    }
}
