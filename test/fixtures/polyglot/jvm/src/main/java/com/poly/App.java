package com.poly;

import com.google.common.collect.ImmutableList;
import com.poly.model.User;

/** Entry point. {@link Helper} is in the same package and needs no import. */
public class App {
  public static void main(String[] args) {
    User user = new User("a");
    System.out.println(Helper.greet(user) + ImmutableList.of());
  }
}
