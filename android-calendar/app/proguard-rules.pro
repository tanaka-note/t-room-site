-keepattributes Signature,InnerClasses,EnclosingMethod

# Room instantiates WorkManager's generated database through reflection before
# Application.onCreate. Full-mode shrinking must retain its no-arg constructor.
-keepclassmembers class * extends androidx.room.RoomDatabase {
    public <init>();
}
