# Room 的列名在查询里是字符串，混淆后会查不到
-keep class io.liuyiming.chat.data.db.** { *; }
-keepclassmembers class io.liuyiming.chat.data.model.** { <fields>; }
