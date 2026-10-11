package com.poly;

import com.poly.model.User;

final class Helper {
  static String greet(User user) { return "hello " + user.name(); }
}
